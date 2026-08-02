import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  IScraper,
  ScraperInputDto,
  JobResponseDto,
  JobPostDto,
  LocationDto,
  Site,
  DescriptionFormat,
} from '@ever-jobs/models';
import {
  createHttpClient,
  htmlToPlainText,
  markdownConverter,
  extractEmails,
  toDateOnly,
} from '@ever-jobs/common';
import {
  LIVEHIRE_BASE,
  LIVEHIRE_ROOT_DOMAIN,
  LIVEHIRE_WIDGET_PATH,
  LIVEHIRE_CAREERS_PATH,
  LIVEHIRE_JOB_LINK_REGEX,
  LIVEHIRE_REMOTE_REGEX,
  LIVEHIRE_DEFAULT_RESULTS,
  LIVEHIRE_MAX_PAGES,
  LIVEHIRE_HEADERS,
} from './livehire.constants';
import { LiveHireJob, LiveHireWidgetJob } from './livehire.types';

/**
 * LiveHire (Humanforce Talent) ATS careers scraper — generic, multi-tenant.
 *
 * LiveHire (livehire.com, Australia / global) powers each customer's talent-community
 * careers board on the shared host `https://www.livehire.com/careers/{tenant}/jobs`.
 * That board is a client-rendered SPA whose backing JSON API rejects non-browser
 * clients, so instead of the SPA the adapter consumes LiveHire's server-rendered,
 * public, unauthenticated embeddable jobs widget for the same tenant, keyed by the
 * same company slug:
 *
 *   GET https://www.livehire.com/widgets/job-listings/{tenant}
 *
 * The widget lists every open role as a canonical careers anchor of the form
 * `/careers/{tenant}/job/{CODE}/{ID}/{title-slug}` alongside labelled card text
 * (title heading, "Location …", "Work Type …", optional "Salary Range …",
 * "Published At …"). The opaque `{ID}` segment is the stable ATS id and the anchor
 * URL is the canonical detail / apply URL.
 *
 * The caller addresses a tenant by `companySlug` (e.g. `perthmint`) or by
 * `companyUrl` (a careers / widget URL whose path encodes the tenant slug). An
 * unknown tenant (or one with no open roles) renders a "Showing 0 of 0 / No open
 * positions" widget, so it degrades naturally to an empty result. A fetch error, an
 * HTTP 4xx, a DNS failure, or a malformed body degrades to an empty / partial
 * result rather than throwing, so a single tenant never nukes a batch run.
 */
@SourcePlugin({
  site: Site.LIVEHIRE,
  name: 'LiveHire',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class LiveHireService implements IScraper {
  private readonly logger = new Logger(LiveHireService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for LiveHire scraper');
      return new JobResponseDto([]);
    }

    const tenant = this.resolveTenant(companySlug, input.companyUrl);
    if (!tenant) {
      this.logger.warn('Could not resolve a LiveHire tenant slug from input');
      return new JobResponseDto([]);
    }

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(LIVEHIRE_HEADERS);

    const resultsWanted = input.resultsWanted ?? LIVEHIRE_DEFAULT_RESULTS;
    const seen = new Set<string>();
    const jobPosts: JobPostDto[] = [];

    try {
      this.logger.log(`Fetching LiveHire jobs for tenant: ${tenant}`);

      // Walk the widget surface (single page in practice) until we have enough roles.
      const items = await this.fetchJobList(client, tenant, resultsWanted, seen);
      if (items.length === 0) {
        this.logger.log(`LiveHire tenant "${tenant}" has no open roles`);
        return new JobResponseDto([]);
      }

      for (const item of items) {
        try {
          const post = this.processItem(item, tenant, input.descriptionFormat);
          if (post) jobPosts.push(post);
        } catch (err: any) {
          this.logger.warn(`Error processing LiveHire role ${item.id}: ${err.message}`);
        }
      }

      this.logger.log(`LiveHire total: ${jobPosts.length} jobs for ${tenant}`);
      return new JobResponseDto(jobPosts);
    } catch (err: any) {
      this.logger.error(`LiveHire scrape error for ${tenant}: ${err.message}`);
      return new JobResponseDto(jobPosts); // partial results
    }
  }

  /**
   * Fetch + parse the tenant's widget HTML, accumulating up to `resultsWanted`
   * deduped roles. The widget renders the full board in one document; the page loop
   * is a guard against any future server-side pagination. An unknown tenant renders
   * an empty widget; an HTTP 4xx or a missing body degrades to an empty list.
   */
  private async fetchJobList(
    client: ReturnType<typeof createHttpClient>,
    tenant: string,
    resultsWanted: number,
    seen: Set<string>,
  ): Promise<LiveHireWidgetJob[]> {
    const items: LiveHireWidgetJob[] = [];
    const base = `${LIVEHIRE_BASE}${LIVEHIRE_WIDGET_PATH}${encodeURIComponent(tenant)}`;

    for (let page = 1; page <= LIVEHIRE_MAX_PAGES; page++) {
      const url = page === 1 ? base : `${base}?page=${page}`;
      const html = await this.fetchHtml(client, url, tenant);
      if (html == null) break;

      const parsed = this.parseWidget(html, tenant);
      let added = 0;
      for (const role of parsed) {
        const id = this.cleanText(role.id);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        items.push(role);
        added++;
        if (items.length >= resultsWanted) return items;
      }

      // The widget is single-document; stop once a page yields no new roles.
      if (added === 0) break;
    }

    return items;
  }

  /** GET a widget URL as text; an HTTP 4xx / DNS failure degrades to null (no throw). */
  private async fetchHtml(
    client: ReturnType<typeof createHttpClient>,
    url: string,
    tenant: string,
  ): Promise<string | null> {
    try {
      const response = await client.get<string>(url, { responseType: 'text' });
      return typeof response.data === 'string' ? response.data : null;
    } catch (err: any) {
      const status = err?.response?.status;
      if (status && status >= 400 && status < 500) {
        this.logger.warn(`LiveHire widget not found (HTTP ${status}) for ${tenant}`);
        return null;
      }
      // 5xx / network / DNS error — degrade gracefully rather than throwing.
      this.logger.warn(`LiveHire widget fetch failed for ${tenant}: ${err?.message ?? err}`);
      return null;
    }
  }

  /**
   * Parse the server-rendered widget HTML into role fragments. Rather than depend on
   * volatile CSS class names, we anchor on the canonical careers job links
   * (`/careers/{tenant}/job/{CODE}/{ID}/{title-slug}`) and read the labelled card
   * text immediately around each link.
   */
  private parseWidget(html: string, tenant: string): LiveHireWidgetJob[] {
    const out: LiveHireWidgetJob[] = [];
    const byId = new Map<string, LiveHireWidgetJob>();

    LIVEHIRE_JOB_LINK_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = LIVEHIRE_JOB_LINK_REGEX.exec(html)) !== null) {
      const [, linkTenant, code, id, titleSlug] = match;
      const jobId = this.cleanText(id);
      if (!jobId) continue;
      // Tolerate the link's own tenant differing in case from the requested one.
      const resolvedTenant = this.cleanText(linkTenant) ?? tenant;
      if (byId.has(jobId)) continue;

      const url = `${LIVEHIRE_BASE}${LIVEHIRE_CAREERS_PATH}${resolvedTenant}/job/${code}/${jobId}/${titleSlug}`;

      // Pull a window of HTML around the link to recover the labelled card fields.
      const windowText = this.cardWindow(html, match.index);

      const role: LiveHireWidgetJob = {
        id: jobId,
        code: this.cleanText(code),
        slug: this.deslugTitleSlug(titleSlug),
        url,
        title: this.titleFromSlug(titleSlug),
        location: this.fieldFromWindow(windowText, 'Location'),
        workType: this.fieldFromWindow(windowText, 'Work\\s*Type'),
        salaryRange: this.fieldFromWindow(windowText, 'Salary\\s*Range'),
        publishedAt: this.fieldFromWindow(windowText, 'Published\\s*At'),
      };

      byId.set(jobId, role);
      out.push(role);
    }

    return out;
  }

  /**
   * Extract a window of plain text around a job link, used to recover the card's
   * labelled fields. The widget renders the card's fields close to its anchor, so a
   * bounded slice on either side captures them without bleeding into siblings.
   */
  private cardWindow(html: string, index: number): string {
    const start = Math.max(0, index - 400);
    const end = Math.min(html.length, index + 1200);
    return htmlToPlainText(html.slice(start, end)) ?? '';
  }

  /**
   * Read a labelled card field (e.g. "Location Perth Airport WA 6105, Australia")
   * out of the card window, stopping at the next known label or a line break.
   */
  private fieldFromWindow(windowText: string, label: string): string | null {
    if (!windowText) return null;
    const re = new RegExp(
      `${label}\\s*:?\\s*(.+?)(?:\\s*(?:Location|Work\\s*Type|Salary\\s*Range|Published\\s*At|Apply|Save|View)\\b|[\\r\\n]|$)`,
      'i',
    );
    const m = re.exec(windowText);
    return m ? this.cleanText(m[1]) : null;
  }

  /** Map a parsed widget role → JobPostDto. */
  private processItem(
    item: LiveHireWidgetJob,
    tenant: string,
    format: DescriptionFormat | undefined,
  ): JobPostDto | null {
    const job = this.normaliseJob(item, tenant);
    return this.processJob(job, tenant, format);
  }

  /** Build a normalised LiveHireJob from a parsed widget role. */
  private normaliseJob(item: LiveHireWidgetJob, tenant: string): LiveHireJob {
    const jobId = this.cleanText(item.id) ?? '';
    const title = this.cleanText(item.title);
    const locationText = this.cleanText(item.location);
    const { city, state, country } = this.splitLocation(locationText);

    return {
      jobId,
      url: this.cleanText(item.url) ?? this.buildJobUrl(tenant, item),
      title,
      companyName: this.deriveCompanyName(tenant),
      city,
      state,
      country,
      locationText,
      employmentType: this.normaliseEmploymentType(item.workType),
      datePosted: this.parseDate(item.publishedAt),
      isRemote: this.detectRemote(title, locationText, item.workType),
    };
  }

  /** Map a normalised LiveHireJob → JobPostDto. */
  private processJob(
    job: LiveHireJob,
    tenant: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const title = job.title;
    if (!title) return null;

    const atsId = String(job.jobId ?? '');
    if (!atsId) return null;

    const jobUrl = job.url;
    if (!jobUrl) return null;

    const companyName = job.companyName ?? this.deriveCompanyName(tenant);
    // The widget exposes no full job-ad body; the location line is the best
    // listing-level descriptive text we can offer, formatted per the request.
    const description = this.formatDescription(job.locationText ?? null, format);

    return new JobPostDto({
      id: `livehire-${atsId}`,
      title,
      companyName,
      jobUrl,
      location: this.extractLocation(job),
      description,
      datePosted: job.datePosted ?? null,
      isRemote: job.isRemote ?? false,
      emails: extractEmails(description ?? ''),
      site: Site.LIVEHIRE,
      atsId,
      atsType: 'livehire',
      department: null,
      employmentType: this.cleanText(job.employmentType),
      applyUrl: jobUrl,
    });
  }

  /**
   * Convert the listing-level descriptive text per `descriptionFormat`. The text is
   * already plain (the location line), so HTML / markdown / plain all return it as-is.
   */
  private formatDescription(text: string | null, format?: DescriptionFormat): string | null {
    if (!text) return null;
    if (format === DescriptionFormat.HTML) return text;
    if (format === DescriptionFormat.MARKDOWN) return markdownConverter(text) ?? text;
    return htmlToPlainText(text) ?? text;
  }

  /**
   * Resolve the tenant slug. An explicit `companySlug` is used directly (a bare
   * portal / widget URL passed as the slug is reduced to its tenant token); a
   * `companyUrl` on a `livehire.com` host has the tenant taken from its careers /
   * widget path segment. Returns an empty string when neither yields a tenant.
   */
  private resolveTenant(companySlug: string | undefined, companyUrl: string | undefined): string {
    if (companySlug && companySlug.trim()) {
      const slug = companySlug.trim();
      // A caller may also pass a full careers / widget URL as the slug.
      if (/^https?:\/\//i.test(slug) || slug.includes(LIVEHIRE_ROOT_DOMAIN)) {
        const fromUrl = this.tenantFromUrl(slug);
        if (fromUrl) return fromUrl;
      }
      return slug.toLowerCase();
    }
    if (companyUrl) {
      const fromUrl = this.tenantFromUrl(companyUrl);
      if (fromUrl) return fromUrl;
    }
    return '';
  }

  /**
   * Derive the tenant token from a LiveHire URL. The candidate-facing forms are
   * `https://www.livehire.com/careers/{tenant}/jobs`,
   * `https://www.livehire.com/widgets/job-listings/{tenant}`, and
   * `https://www.livehire.com/talent/community/{tenant}/careers/`.
   */
  private tenantFromUrl(value: string): string {
    const raw = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    try {
      const u = new URL(raw);
      const hostname = u.hostname.toLowerCase();
      if (!hostname.endsWith(LIVEHIRE_ROOT_DOMAIN)) return '';
      const segments = u.pathname.split('/').filter((s) => s.length > 0);
      if (segments.length === 0) return '';
      const first = segments[0].toLowerCase();

      // /careers/{tenant}/...  and  /careers/{tenant}/job/...
      if (first === 'careers' && segments.length > 1) {
        return decodeURIComponent(segments[1]).toLowerCase();
      }
      // /widgets/job-listings/{tenant}
      if (first === 'widgets' && segments.length > 2) {
        return decodeURIComponent(segments[2]).toLowerCase();
      }
      // /talent/community/{tenant}/careers/...
      if (first === 'talent' && segments.length > 2 && segments[1].toLowerCase() === 'community') {
        return decodeURIComponent(segments[2]).toLowerCase();
      }
    } catch {
      // Malformed URL — no tenant.
    }
    return '';
  }

  /** Build the canonical public detail / apply URL for a role from its parts. */
  private buildJobUrl(tenant: string, item: LiveHireWidgetJob): string {
    const code = this.cleanText(item.code) ?? '';
    const id = this.cleanText(item.id) ?? '';
    const slug = this.cleanText(item.slug) ?? '';
    return `${LIVEHIRE_BASE}${LIVEHIRE_CAREERS_PATH}${tenant}/job/${code}/${id}/${slug}`;
  }

  /** De-slugify + title-case the tenant token into a display company name. */
  private deriveCompanyName(tenant: string): string {
    const base = tenant && tenant.trim() ? tenant.trim() : tenant;
    return base.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /** Turn a URL title slug (e.g. `officer-security`) into a readable title. */
  private titleFromSlug(slug: string | null | undefined): string | null {
    const cleaned = this.cleanText(slug ? decodeURIComponent(slug) : null);
    if (!cleaned) return null;
    return cleaned.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /** Normalise a raw title slug for storage (lower-case, dash-separated). */
  private deslugTitleSlug(slug: string | null | undefined): string | null {
    const cleaned = this.cleanText(slug ? decodeURIComponent(slug) : null);
    return cleaned ? cleaned.toLowerCase() : null;
  }

  /**
   * Surface the role's location parts as a LocationDto, leaving location null when
   * nothing usable is present. LiveHire renders a single free-text location line
   * (e.g. "Perth Airport WA 6105, Australia"); we keep the trailing token as country
   * and the leading text as city, best-effort.
   */
  private extractLocation(job: LiveHireJob): LocationDto | null {
    const city = job.city;
    const state = job.state;
    const country = job.country;
    if (!city && !state && !country) return null;
    return new LocationDto({ city, state, country });
  }

  /**
   * Best-effort split of a single free-text location line into city / state /
   * country. Comma-separated tail is treated as the country; the head as the city.
   */
  private splitLocation(
    text: string | null,
  ): { city: string | null; state: string | null; country: string | null } {
    if (!text || this.isRemoteToken(text)) {
      return { city: null, state: null, country: null };
    }
    const parts = text
      .split(',')
      .map((p) => this.cleanText(p))
      .filter((p): p is string => !!p);
    if (parts.length === 0) return { city: null, state: null, country: null };
    if (parts.length === 1) return { city: parts[0], state: null, country: null };
    const country = parts[parts.length - 1];
    const city = parts.slice(0, parts.length - 1).join(', ');
    return { city: city || null, state: null, country: country || null };
  }

  /** Detect remote roles from the title, location, or work-type text. */
  private detectRemote(
    title: string | null,
    location: string | null,
    workType: string | null | undefined,
  ): boolean {
    const haystacks: Array<string | null | undefined> = [title, location, workType];
    for (const field of haystacks) {
      if (typeof field !== 'string') continue;
      if (LIVEHIRE_REMOTE_REGEX.test(field)) return true;
    }
    return false;
  }

  /** True when a location token is a bare "Remote" marker rather than a real place. */
  private isRemoteToken(value: string): boolean {
    return /^remote$/i.test(value.trim());
  }

  /**
   * Normalise a LiveHire work-type token (e.g. "Full Time - Fixed Term",
   * "Part Time", "Casual / Vacation") into a readable, trimmed, title-cased label.
   */
  private normaliseEmploymentType(value: string | null | undefined): string | null {
    const cleaned = this.cleanText(value);
    if (!cleaned) return null;
    const spaced = cleaned
      .replace(/[_]+/g, ' ')
      .replace(/\bfulltime\b/i, 'full time')
      .replace(/\bparttime\b/i, 'part time')
      .replace(/\s{2,}/g, ' ')
      .trim();
    return spaced.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /**
   * Parse a "Published At" value into a YYYY-MM-DD string. LiveHire frequently
   * renders a relative value ("10 hours ago"), which is not an absolute date — those
   * yield null; an absolute date string is parsed and normalised.
   */
  private parseDate(value: string | null | undefined): string | null {
    const cleaned = this.cleanText(value);
    if (!cleaned) return null;
    if (/\bago\b/i.test(cleaned)) return null; // relative, not an absolute date
    try {
      const parsed = new Date(cleaned);
      if (!isNaN(parsed.getTime())) return toDateOnly(cleaned);
    } catch {
      // ignore
    }
    return null;
  }

  /** Trim a string, returning null for empty / non-string values. */
  private cleanText(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null;
    const v = value.trim();
    return v.length > 0 ? v : null;
  }
}
