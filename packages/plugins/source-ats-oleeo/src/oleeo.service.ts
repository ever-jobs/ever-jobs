import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
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
  OLEEO_ROOT_DOMAIN,
  OLEEO_HOST_TEMPLATE,
  OLEEO_BOARD_PATH,
  OLEEO_OPP_PATH_TOKEN,
  OLEEO_OPP_LINK_REGEX,
  OLEEO_REMOTE_REGEX,
  OLEEO_DATE_LABEL_REGEX,
  OLEEO_DEFAULT_RESULTS,
  OLEEO_MAX_PAGES,
  OLEEO_PAGE_SIZE,
  OLEEO_HEADERS,
} from './oleeo.constants';
import { OleeoBoardJob, OleeoJob } from './oleeo.types';

/**
 * Oleeo (TAL.net) ATS careers scraper — generic, multi-tenant.
 *
 * Oleeo (oleeo.com, UK) is an enterprise e-recruitment platform used widely across
 * the UK public sector, policing, government, and finance. Every customer tenant
 * publishes a branded, public, unauthenticated candidate careers portal on its own
 * sub-domain of the shared host `https://{tenant}.tal.net/`. The candidate-facing
 * job board is **server-rendered HTML**, reached at the stable, brand-agnostic
 * short path:
 *
 *   GET https://{tenant}.tal.net/candidate/jobboard/vacancy/1/adv/
 *
 * The board lists every open opportunity as a canonical anchor of the form
 * `…/opp/{ID}-{title-slug}/en-GB`, where the numeric `{ID}` is the stable ATS id
 * and the anchor is the canonical detail / apply URL. The adapter enumerates those
 * anchors, then fetches each role's server-rendered detail page for the title,
 * location, body, employment type, and closing/posted date (no schema.org JSON-LD
 * is emitted, so the body is read defensively from the HTML).
 *
 * The caller addresses a tenant by `companySlug` (the sub-domain label, e.g.
 * `fcdo`) or by `companyUrl` (any portal URL on a `tal.net` host whose leading
 * sub-domain label is the tenant). An unknown tenant resolves to a non-existent
 * host (DNS failure) or an empty board, so it degrades naturally to an empty
 * result. A fetch error, an HTTP 4xx, a DNS failure, or a malformed body degrades
 * to an empty / partial result rather than throwing, so a single bad tenant never
 * breaks a batch run.
 */
@SourcePlugin({
  site: Site.OLEEO,
  name: 'Oleeo',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class OleeoService implements IScraper {
  private readonly logger = new Logger(OleeoService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for Oleeo scraper');
      return new JobResponseDto([]);
    }

    const tenant = this.resolveTenant(companySlug, input.companyUrl);
    if (!tenant) {
      this.logger.warn('Could not resolve an Oleeo tenant slug from input');
      return new JobResponseDto([]);
    }

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(OLEEO_HEADERS);

    const resultsWanted = input.resultsWanted ?? OLEEO_DEFAULT_RESULTS;
    const seen = new Set<string>();
    const jobPosts: JobPostDto[] = [];

    try {
      this.logger.log(`Fetching Oleeo jobs for tenant: ${tenant}`);

      // Enumerate opportunity anchors off the server-rendered board (paged by ?start=).
      const items = await this.fetchJobList(client, tenant, resultsWanted, seen);
      if (items.length === 0) {
        this.logger.log(`Oleeo tenant "${tenant}" has no open roles`);
        return new JobResponseDto([]);
      }

      // Fan out to each detail page; Promise.allSettled so one bad page never nukes the batch.
      const settled = await Promise.allSettled(
        items.map((item) => this.hydrateDetail(client, item, tenant)),
      );

      for (let i = 0; i < settled.length; i++) {
        const outcome = settled[i];
        const base = items[i];
        const hydrated = outcome.status === 'fulfilled' ? outcome.value : base;
        if (outcome.status === 'rejected') {
          this.logger.warn(
            `Error hydrating Oleeo role ${base.id}: ${outcome.reason?.message ?? outcome.reason}`,
          );
        }
        try {
          const post = this.processItem(hydrated, tenant, input.descriptionFormat);
          if (post) jobPosts.push(post);
        } catch (err: any) {
          this.logger.warn(`Error processing Oleeo role ${base.id}: ${err.message}`);
        }
      }

      this.logger.log(`Oleeo total: ${jobPosts.length} jobs for ${tenant}`);
      return new JobResponseDto(jobPosts);
    } catch (err: any) {
      this.logger.error(`Oleeo scrape error for ${tenant}: ${err.message}`);
      // Partial results WITH a reason: jobs.length > 0 plus a diagnostic is
      // inferred as 'partial' upstream, so a mid-scrape failure is no longer
      // indistinguishable from a complete board.
      return new JobResponseDto(jobPosts, classifyScrapeError(err));
    }
  }

  /**
   * Fetch + parse the tenant's board HTML, accumulating up to `resultsWanted`
   * deduped opportunity anchors. The board renders the full set in one document for
   * small boards; larger boards page via `?start=` (50 roles/page), so the loop
   * walks offsets until a page yields no new roles or the page cap is hit. An
   * unknown tenant (DNS failure / empty board) degrades to an empty list.
   */
  private async fetchJobList(
    client: ReturnType<typeof createHttpClient>,
    tenant: string,
    resultsWanted: number,
    seen: Set<string>,
  ): Promise<OleeoBoardJob[]> {
    const items: OleeoBoardJob[] = [];
    const base = `${this.hostFor(tenant)}${OLEEO_BOARD_PATH}`;

    for (let page = 0; page < OLEEO_MAX_PAGES; page++) {
      const start = page * OLEEO_PAGE_SIZE;
      const url = start === 0 ? base : `${base}?start=${start}`;
      const html = await this.fetchHtml(client, url, tenant);
      if (html == null) break;

      const parsed = this.parseBoard(html, tenant);
      let added = 0;
      for (const role of parsed) {
        const id = this.cleanText(role.id);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        items.push(role);
        added++;
        if (items.length >= resultsWanted) return items;
      }

      // Stop once a page yields no new roles (single-document board or end of paging).
      if (added === 0) break;
    }

    return items;
  }

  /** GET a board / detail URL as text; an HTTP 4xx / DNS failure degrades to null (no throw). */
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
        this.logger.warn(`Oleeo page not found (HTTP ${status}) for ${tenant}`);
        return null;
      }
      // 5xx / network / DNS error — degrade gracefully rather than throwing.
      this.logger.warn(`Oleeo page fetch failed for ${tenant}: ${err?.message ?? err}`);
      return null;
    }
  }

  /**
   * Parse the server-rendered board HTML into opportunity fragments. Rather than
   * depend on volatile CSS class names, we anchor on the canonical opportunity
   * links (`…/opp/{ID}-{title-slug}/en-GB`), capturing the numeric id and the title
   * slug. The full absolute detail URL is recovered from the surrounding href.
   */
  private parseBoard(html: string, tenant: string): OleeoBoardJob[] {
    const out: OleeoBoardJob[] = [];
    const byId = new Map<string, OleeoBoardJob>();

    OLEEO_OPP_LINK_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = OLEEO_OPP_LINK_REGEX.exec(html)) !== null) {
      const [, id, titleSlug] = match;
      const jobId = this.cleanText(id);
      if (!jobId || byId.has(jobId)) continue;

      const url = this.absoluteUrlAround(html, match.index, tenant);

      const role: OleeoBoardJob = {
        id: jobId,
        slug: this.deslugTitleSlug(titleSlug),
        url,
        title: this.titleFromSlug(titleSlug),
      };

      byId.set(jobId, role);
      out.push(role);
    }

    return out;
  }

  /**
   * Recover the absolute detail URL for an opportunity from the href that encloses
   * its `/opp/{ID}` token. Falls back to a canonical, brand-agnostic `/opp/` URL on
   * the tenant host when no fuller href is recoverable.
   */
  private absoluteUrlAround(html: string, index: number, tenant: string): string {
    // Walk back to the opening quote of the enclosing attribute value.
    let start = index;
    while (start > 0 && !['"', "'"].includes(html[start - 1])) start--;
    let end = index;
    while (end < html.length && !['"', "'", ' ', '>'].includes(html[end])) end++;
    const raw = this.cleanText(html.slice(start, end));

    if (raw) {
      if (/^https?:\/\//i.test(raw)) return raw;
      if (raw.startsWith('/')) return `${this.hostFor(tenant)}${raw}`;
    }
    return '';
  }

  /**
   * Fetch + parse an opportunity's server-rendered detail page, enriching the board
   * fragment with the title, location, employment type, closing/posted date, and
   * body HTML. A failed/empty fetch leaves the board fragment unchanged (slug-only).
   */
  private async hydrateDetail(
    client: ReturnType<typeof createHttpClient>,
    item: OleeoBoardJob,
    tenant: string,
  ): Promise<OleeoBoardJob> {
    const url = this.cleanText(item.url) ?? this.buildJobUrl(tenant, item);
    if (!url) return item;

    const html = await this.fetchHtml(client, url, tenant);
    if (html == null) return { ...item, url };

    const text = htmlToPlainText(html) ?? '';
    const bodyHtml = this.extractBody(html);

    return {
      ...item,
      url,
      title: this.titleFromDetail(html) ?? item.title,
      location: this.fieldFromText(text, 'Location') ?? this.fieldFromText(text, 'Country'),
      employmentType:
        this.fieldFromText(text, 'Employment\\s*Type') ??
        this.fieldFromText(text, 'Type\\s*of\\s*Role') ??
        this.fieldFromText(text, 'Working\\s*Pattern'),
      dateText: this.dateFromText(text),
      bodyHtml: bodyHtml ?? html,
    };
  }

  /**
   * Pull the role title from the detail HTML — preferring an `og:title` / `<title>`
   * meta, then the first `<h1>`. The platform suffixes the document title with the
   * tenant brand; we keep the leading title token.
   */
  private titleFromDetail(html: string): string | null {
    const og = /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i.exec(html);
    if (og && this.cleanText(og[1])) return this.splitBrand(this.cleanText(og[1]));

    const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
    if (h1) {
      const t = this.cleanText(htmlToPlainText(h1[1]) ?? h1[1]);
      if (t) return t;
    }

    const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
    if (title) {
      const t = this.cleanText(htmlToPlainText(title[1]) ?? title[1]);
      if (t) return this.splitBrand(t);
    }
    return null;
  }

  /** Drop a trailing " - {brand}" / " | {brand}" suffix from a document title. */
  private splitBrand(value: string | null): string | null {
    const cleaned = this.cleanText(value);
    if (!cleaned) return null;
    const m = /^(.*?)\s*[|\-–—]\s*[^|\-–—]+$/.exec(cleaned);
    return this.cleanText(m ? m[1] : cleaned) ?? cleaned;
  }

  /**
   * Best-effort extraction of the main body HTML from a detail page. Prefers an
   * `<article>` / role description container; falls back to the whole document so
   * the description is never empty when a body exists.
   */
  private extractBody(html: string): string | null {
    const article = /<article[\s\S]*?<\/article>/i.exec(html);
    if (article && this.cleanText(htmlToPlainText(article[0]) ?? '')) return article[0];
    const main = /<main[\s\S]*?<\/main>/i.exec(html);
    if (main && this.cleanText(htmlToPlainText(main[0]) ?? '')) return main[0];
    return null;
  }

  /**
   * Read a labelled field (e.g. "Location: Belgrade, Serbia") out of the detail
   * plain text, stopping at the next known label or a line break.
   */
  private fieldFromText(text: string, label: string): string | null {
    if (!text) return null;
    const re = new RegExp(
      `${label}\\s*:?\\s*(.+?)(?:\\s*(?:Location|Country|Employment\\s*Type|Type\\s*of\\s*Role|Working\\s*Pattern|Salary|Closing\\s*Date|Apply|Job\\s*Reference)\\b|[\\r\\n]|$)`,
      'i',
    );
    const m = re.exec(text);
    return m ? this.cleanText(m[1]) : null;
  }

  /** Recover an absolute closing/posted date from a labelled line in the body text. */
  private dateFromText(text: string): string | null {
    if (!text) return null;
    const m = OLEEO_DATE_LABEL_REGEX.exec(text);
    return m ? this.cleanText(m[1]) : null;
  }

  /** Map a parsed (and possibly hydrated) board role → JobPostDto. */
  private processItem(
    item: OleeoBoardJob,
    tenant: string,
    format: DescriptionFormat | undefined,
  ): JobPostDto | null {
    const job = this.normaliseJob(item, tenant, format);
    return this.processJob(job, tenant);
  }

  /** Build a normalised OleeoJob from a parsed board role. */
  private normaliseJob(
    item: OleeoBoardJob,
    tenant: string,
    format: DescriptionFormat | undefined,
  ): OleeoJob {
    const jobId = this.cleanText(item.id) ?? '';
    const title = this.cleanText(item.title);
    const locationText = this.cleanText(item.location);
    const { city, state, country } = this.splitLocation(locationText);
    const description = this.formatDescription(item.bodyHtml ?? null, format);

    return {
      jobId,
      url: this.cleanText(item.url) ?? this.buildJobUrl(tenant, item),
      title,
      companyName: this.deriveCompanyName(tenant),
      city,
      state,
      country,
      locationText,
      employmentType: this.normaliseEmploymentType(item.employmentType),
      datePosted: this.parseDate(item.dateText),
      isRemote: this.detectRemote(title, locationText, description),
      description,
    };
  }

  /** Map a normalised OleeoJob → JobPostDto. */
  private processJob(job: OleeoJob, tenant: string): JobPostDto | null {
    const title = job.title;
    if (!title) return null;

    const atsId = String(job.jobId ?? '');
    if (!atsId) return null;

    const jobUrl = job.url;
    if (!jobUrl) return null;

    const companyName = job.companyName ?? this.deriveCompanyName(tenant);
    const description = job.description ?? null;

    return new JobPostDto({
      id: `oleeo-${atsId}`,
      title,
      companyName,
      jobUrl,
      location: this.extractLocation(job),
      description,
      datePosted: job.datePosted ?? null,
      isRemote: job.isRemote ?? false,
      emails: extractEmails(description ?? ''),
      site: Site.OLEEO,
      atsId,
      atsType: 'oleeo',
      department: null,
      employmentType: this.cleanText(job.employmentType),
      applyUrl: jobUrl,
    });
  }

  /** Convert the detail body HTML per `descriptionFormat` (HTML / Markdown / Plain). */
  private formatDescription(html: string | null, format?: DescriptionFormat): string | null {
    if (!html) return null;
    if (format === DescriptionFormat.HTML) return html;
    if (format === DescriptionFormat.MARKDOWN) return markdownConverter(html) ?? html;
    return htmlToPlainText(html) ?? html;
  }

  /**
   * Resolve the tenant sub-domain label. An explicit `companySlug` is used directly
   * (a bare portal URL passed as the slug is reduced to its tenant token); a
   * `companyUrl` on a `tal.net` host has the tenant taken from its leading
   * sub-domain label. Returns an empty string when neither yields a tenant.
   */
  private resolveTenant(companySlug: string | undefined, companyUrl: string | undefined): string {
    if (companySlug && companySlug.trim()) {
      const slug = companySlug.trim();
      // A caller may also pass a full portal URL as the slug.
      if (/^https?:\/\//i.test(slug) || slug.includes(OLEEO_ROOT_DOMAIN)) {
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
   * Derive the tenant token from an Oleeo (tal.net) URL. The candidate-facing host
   * is `https://{tenant}.tal.net/…`; the tenant is the leading sub-domain label.
   */
  private tenantFromUrl(value: string): string {
    const raw = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    try {
      const u = new URL(raw);
      const hostname = u.hostname.toLowerCase();
      if (!hostname.endsWith(`.${OLEEO_ROOT_DOMAIN}`) && hostname !== OLEEO_ROOT_DOMAIN) return '';
      const labels = hostname.split('.');
      // {tenant}.tal.net  →  labels = [tenant, 'tal', 'net']
      if (labels.length >= 3) {
        const tenant = labels[0];
        if (tenant && tenant !== 'www') return tenant;
      }
    } catch {
      // Malformed URL — no tenant.
    }
    return '';
  }

  /** Build the tenant's candidate-portal host. */
  private hostFor(tenant: string): string {
    return OLEEO_HOST_TEMPLATE.replace('{tenant}', encodeURIComponent(tenant));
  }

  /** Build the canonical public detail / apply URL for a role from its parts. */
  private buildJobUrl(tenant: string, item: OleeoBoardJob): string {
    const id = this.cleanText(item.id) ?? '';
    const slug = this.cleanText(item.slug) ?? '';
    if (!id) return '';
    const tail = slug ? `${id}-${slug}` : id;
    return `${this.hostFor(tenant)}/candidate${OLEEO_OPP_PATH_TOKEN}${tail}/en-GB`;
  }

  /** De-slugify + title-case the tenant token into a display company name. */
  private deriveCompanyName(tenant: string): string {
    const base = tenant && tenant.trim() ? tenant.trim() : tenant;
    return base.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /** Turn a URL title slug (e.g. `Post-Security-Manager`) into a readable title. */
  private titleFromSlug(slug: string | null | undefined): string | null {
    const cleaned = this.cleanText(slug ? decodeURIComponent(slug) : null);
    if (!cleaned) return null;
    return cleaned.replace(/[-_]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  }

  /** Normalise a raw title slug for storage (lower-case, dash-separated). */
  private deslugTitleSlug(slug: string | null | undefined): string | null {
    const cleaned = this.cleanText(slug ? decodeURIComponent(slug) : null);
    return cleaned ? cleaned.toLowerCase() : null;
  }

  /**
   * Surface the role's location parts as a LocationDto, leaving location null when
   * nothing usable is present.
   */
  private extractLocation(job: OleeoJob): LocationDto | null {
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

  /** Detect remote roles from the title, location, or description text. */
  private detectRemote(
    title: string | null,
    location: string | null,
    description: string | null,
  ): boolean {
    const haystacks: Array<string | null | undefined> = [title, location, description];
    for (const field of haystacks) {
      if (typeof field !== 'string') continue;
      if (OLEEO_REMOTE_REGEX.test(field)) return true;
    }
    return false;
  }

  /** True when a location token is a bare "Remote" marker rather than a real place. */
  private isRemoteToken(value: string): boolean {
    return /^remote$/i.test(value.trim());
  }

  /**
   * Normalise an employment-type token (e.g. "FULL_TIME", "Full Time - Permanent")
   * into a readable, trimmed, title-cased label.
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
   * Parse a closing/posted date value into a YYYY-MM-DD string. A relative value
   * ("3 days ago") is not an absolute date and yields null; an absolute date string
   * is parsed and normalised.
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
