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
} from '@ever-jobs/common';
import {
  TEMPWORKS_BOARD_ORIGIN,
  TEMPWORKS_ROOT_DOMAIN,
  TEMPWORKS_SEARCH_PATH,
  TEMPWORKS_DETAILS_PATH,
  TEMPWORKS_DETAIL_LINK_REGEX,
  TEMPWORKS_CARD_TITLE_REGEX,
  TEMPWORKS_CARD_LOCATION_REGEX,
  TEMPWORKS_DETAIL_TITLE_REGEX,
  TEMPWORKS_APPLY_HREF_REGEX,
  TEMPWORKS_OG_TITLE_REGEX,
  TEMPWORKS_OG_DESCRIPTION_REGEX,
  TEMPWORKS_TITLE_TAG_REGEX,
  TEMPWORKS_DESCRIPTION_BLOCK_REGEX,
  TEMPWORKS_REMOTE_REGEX,
  TEMPWORKS_DEFAULT_RESULTS,
  TEMPWORKS_HEADERS,
} from './tempworks.constants';
import { TempWorksJob, TempWorksListingEntry } from './tempworks.types';

/**
 * TempWorks Job Board ATS careers scraper — generic, multi-tenant.
 *
 * TempWorks (tempworks.com, US) powers each staffing customer's candidate Job
 * Board on the shared host `https://jobboard.ontempworks.com/{tenant}` (where
 * `{tenant}` is the agency's board id). The board is server-rendered, so the
 * adapter reads the tenant's jobs listing page
 * (`/{tenant}/Jobs/Search`, which links every open `/{tenant}/Jobs/Details/{orderId}`
 * page) and enriches each wanted order from its server-rendered detail page
 * (`<h1>` title + ad body + the public HRCenter "Apply with Us" link). The board
 * carries no schema.org JSON-LD, so fields are parsed defensively from the
 * rendered HTML.
 *
 * The caller addresses a tenant by `companySlug` (the board id, e.g.
 * `JustInTimeStaffing`) or by `companyUrl` (a board URL whose first path segment
 * is the tenant). The listing lists every open order in one document — there is
 * no server-side pagination of the order set we depend on — so we fetch once and
 * slice client-side to honour `resultsWanted`. A single fetch error, an unknown
 * tenant (HTTP 4xx), or a malformed page degrades to an empty / partial result
 * rather than throwing, so a single tenant never nukes a batch run.
 */
@SourcePlugin({
  site: Site.TEMPWORKS,
  name: 'TempWorks',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class TempWorksService implements IScraper {
  private readonly logger = new Logger(TempWorksService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for TempWorks scraper');
      return new JobResponseDto([]);
    }

    const tenant = this.resolveTenant(companySlug, input.companyUrl);
    if (!tenant) {
      this.logger.warn('Could not resolve a TempWorks board tenant from input');
      return new JobResponseDto([]);
    }

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(TEMPWORKS_HEADERS);

    const resultsWanted = input.resultsWanted ?? TEMPWORKS_DEFAULT_RESULTS;
    const base = `${TEMPWORKS_BOARD_ORIGIN}/${encodeURIComponent(tenant)}`;
    const seen = new Set<string>();
    const jobPosts: JobPostDto[] = [];

    try {
      this.logger.log(`Fetching TempWorks job board for tenant: ${tenant}`);

      // The listing page enumerates every open order for the tenant in one document.
      const entries = await this.fetchListing(client, base);
      if (entries.length === 0) {
        this.logger.log(`TempWorks tenant "${tenant}" has no open orders`);
        return new JobResponseDto([]);
      }

      // Only enrich as many orders as the caller asked for (deduped first).
      const wanted = entries
        .filter((e) => !seen.has(e.orderId) && seen.add(e.orderId))
        .slice(0, resultsWanted);

      for (const entry of wanted) {
        try {
          const post = await this.processEntry(client, entry, tenant, input.descriptionFormat);
          if (post) jobPosts.push(post);
        } catch (err: any) {
          this.logger.warn(`Error processing TempWorks order ${entry.orderId}: ${err.message}`);
        }
      }

      this.logger.log(`TempWorks total: ${jobPosts.length} jobs for ${tenant}`);
      return new JobResponseDto(jobPosts);
    } catch (err: any) {
      this.logger.error(`TempWorks scrape error for ${tenant}: ${err.message}`);
      // Partial results WITH a reason: jobs.length > 0 plus a diagnostic is
      // inferred as 'partial' upstream, so a mid-scrape failure is no longer
      // indistinguishable from a complete board.
      return new JobResponseDto(jobPosts, classifyScrapeError(err));
    }
  }

  /**
   * Fetch and parse the tenant listing page into open-order entries. An unknown
   * tenant (HTTP 4xx) or a missing listing degrades to an empty list.
   */
  private async fetchListing(
    client: ReturnType<typeof createHttpClient>,
    base: string,
  ): Promise<TempWorksListingEntry[]> {
    const url = `${base}${TEMPWORKS_SEARCH_PATH}`;
    try {
      const response = await client.get<string>(url, { responseType: 'text' });
      const html = typeof response.data === 'string' ? response.data : '';
      return this.parseListing(html, base);
    } catch (err: any) {
      const status = err?.response?.status;
      if (status && status >= 400 && status < 500) {
        this.logger.warn(`TempWorks listing not found (HTTP ${status}) at ${url}`);
        return [];
      }
      throw err;
    }
  }

  /**
   * Extract `/Jobs/Details/{orderId}` cards (with their card title + location)
   * from the listing HTML. Non-job links carry no `/Jobs/Details/{id}` segment
   * and are skipped by the detail-link regex. Each card's heading and emphasised
   * `{city}, {state}` text are read from the markup window around its link.
   */
  private parseListing(html: string, base: string): TempWorksListingEntry[] {
    const entries: TempWorksListingEntry[] = [];
    const seen = new Set<string>();

    const linkRegex = new RegExp(TEMPWORKS_DETAIL_LINK_REGEX.source, 'gi');
    let match: RegExpExecArray | null;
    while ((match = linkRegex.exec(html)) !== null) {
      const orderId = match[2];
      if (!orderId || seen.has(orderId)) continue;
      seen.add(orderId);

      // Read a markup window around the link for the card's heading + location.
      const window = html.slice(match.index, match.index + 600);
      const rawTitle = this.firstGroup(window, TEMPWORKS_CARD_TITLE_REGEX);
      const rawLocation = this.firstGroup(window, TEMPWORKS_CARD_LOCATION_REGEX);
      const { city, state } = this.splitLocation(rawLocation);

      entries.push({
        orderId,
        url: `${base}${TEMPWORKS_DETAILS_PATH}/${orderId}`,
        title: this.cleanCardText(rawTitle),
        city,
        state,
      });
    }

    return entries;
  }

  /** Fetch + parse a single detail page, then map it to a JobPostDto. */
  private async processEntry(
    client: ReturnType<typeof createHttpClient>,
    entry: TempWorksListingEntry,
    tenant: string,
    format: DescriptionFormat | undefined,
  ): Promise<JobPostDto | null> {
    let html = '';
    try {
      const response = await client.get<string>(entry.url, { responseType: 'text' });
      html = typeof response.data === 'string' ? response.data : '';
    } catch (err: any) {
      const status = err?.response?.status;
      if (status && status >= 400 && status < 500) {
        // A closed / removed order 404s; skip it without failing the batch.
        this.logger.warn(`TempWorks order ${entry.orderId} not found (HTTP ${status})`);
        // Fall back to the listing-card data so the role is still surfaced.
        return this.processJob(this.fromEntry(entry, tenant), tenant, format);
      }
      throw err;
    }

    const job = this.parseDetail(html, entry, tenant);
    return this.processJob(job, tenant, format);
  }

  /** Parse a detail page's HTML into a TempWorksJob, enriching the card entry. */
  private parseDetail(html: string, entry: TempWorksListingEntry, tenant: string): TempWorksJob {
    const detailTitle = this.firstGroup(html, TEMPWORKS_DETAIL_TITLE_REGEX);
    const ogTitle = this.firstGroup(html, TEMPWORKS_OG_TITLE_REGEX);
    const titleTag = this.firstGroup(html, TEMPWORKS_TITLE_TAG_REGEX);
    const ogDescription = this.firstGroup(html, TEMPWORKS_OG_DESCRIPTION_REGEX);

    const title =
      this.cleanCardText(detailTitle) ??
      this.cleanText(entry.title) ??
      this.leadingTitle(ogTitle) ??
      this.leadingTitle(titleTag);

    const descriptionHtml = this.firstGroup(html, TEMPWORKS_DESCRIPTION_BLOCK_REGEX);
    const applyUrl = this.firstGroup(html, TEMPWORKS_APPLY_HREF_REGEX);

    return {
      orderId: entry.orderId,
      url: entry.url,
      applyUrl: applyUrl ? this.decodeEntities(applyUrl) : null,
      title: title ? this.decodeEntities(title) : null,
      companyName: this.deriveCompanyName(null, tenant),
      descriptionHtml: descriptionHtml ? this.decodeEntities(descriptionHtml) : null,
      description: ogDescription ? this.decodeEntities(ogDescription) : null,
      city: this.cleanText(entry.city),
      state: this.cleanText(entry.state),
      country: null,
      department: null,
      employmentType: null,
      datePosted: null,
      isRemote: this.detectRemote(title, entry, descriptionHtml),
    };
  }

  /** Build a TempWorksJob from just the listing-card entry (detail fetch failed). */
  private fromEntry(entry: TempWorksListingEntry, tenant: string): TempWorksJob {
    return {
      orderId: entry.orderId,
      url: entry.url,
      applyUrl: null,
      title: this.cleanText(entry.title),
      companyName: this.deriveCompanyName(null, tenant),
      descriptionHtml: null,
      description: null,
      city: this.cleanText(entry.city),
      state: this.cleanText(entry.state),
      country: null,
      department: null,
      employmentType: null,
      datePosted: null,
      isRemote: this.detectRemote(this.cleanText(entry.title), entry, null),
    };
  }

  /** Map a normalised TempWorksJob → JobPostDto. */
  private processJob(
    job: TempWorksJob,
    tenant: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const title = job.title;
    if (!title) return null;

    const atsId = String(job.orderId ?? '');
    if (!atsId) return null;

    const jobUrl = job.url;
    if (!jobUrl) return null;

    const companyName = this.deriveCompanyName(job.companyName, tenant);
    const description = this.formatDescription(job.descriptionHtml ?? null, job.description ?? null, format);

    return new JobPostDto({
      id: `tempworks-${atsId}`,
      title,
      companyName,
      jobUrl,
      location: this.extractLocation(job),
      description,
      datePosted: job.datePosted ?? null,
      isRemote: job.isRemote ?? false,
      emails: extractEmails(description),
      site: Site.TEMPWORKS,
      atsId,
      atsType: 'tempworks',
      department: this.cleanText(job.department),
      employmentType: this.cleanText(job.employmentType),
      applyUrl: job.applyUrl || jobUrl,
    });
  }

  /**
   * Convert the job-ad body per `descriptionFormat`. The detail-page description
   * block is an HTML body; we prefer it so markdown / plain conversion is
   * consistent, falling back to the plain-text `og:description` blob when no HTML
   * body exists.
   */
  private formatDescription(
    html: string | null,
    text: string | null,
    format?: DescriptionFormat,
  ): string | null {
    if (html) {
      if (format === DescriptionFormat.HTML) return html;
      if (format === DescriptionFormat.MARKDOWN) return markdownConverter(html) ?? html;
      return htmlToPlainText(html);
    }
    if (text) {
      // Only a plain-text body is available; surface it as-is for every format.
      return text;
    }
    return null;
  }

  /**
   * Resolve the tenant board id. An explicit `companySlug` is used as the board
   * id; a `companyUrl` on the `ontempworks.com` domain has its first path segment
   * (`/{tenant}/…`) used as the tenant. Returns an empty string when neither
   * yields a tenant.
   */
  private resolveTenant(companySlug: string | undefined, companyUrl: string | undefined): string {
    if (companyUrl) {
      try {
        const u = new URL(companyUrl);
        const hostname = u.hostname.toLowerCase();
        if (hostname === TEMPWORKS_ROOT_DOMAIN || hostname.endsWith(`.${TEMPWORKS_ROOT_DOMAIN}`)) {
          const segment = u.pathname.split('/').filter((s) => s.length > 0)[0];
          if (segment) return decodeURIComponent(segment);
          // No path segment, but the apply host carries the tenant after `/en/`.
          const enMatch = /\/en\/([^/?#]+)/i.exec(u.pathname);
          if (enMatch) return decodeURIComponent(enMatch[1]);
        }
      } catch {
        // Malformed URL — fall through to the slug.
      }
    }
    if (companySlug && companySlug.trim()) {
      const slug = companySlug.trim();
      // A caller may also pass a bare board URL / host path.
      if (slug.includes(TEMPWORKS_ROOT_DOMAIN)) {
        const path = slug.replace(/^https?:\/\//, '').replace(/^[^/]+\//, '');
        const segment = path.split('/').filter((s) => s.length > 0)[0];
        if (segment) return decodeURIComponent(segment);
      }
      return slug;
    }
    return '';
  }

  private deriveCompanyName(company: string | null | undefined, tenant: string): string {
    const base = (typeof company === 'string' && company.trim() ? company.trim() : tenant) || tenant;
    return base
      // Split camel/Pascal-cased board ids (e.g. "JustInTimeStaffing") into words.
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/[-_]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /**
   * Surface the parsed location parts (city / state / country) as a LocationDto,
   * leaving location null when nothing usable is present.
   */
  private extractLocation(job: TempWorksJob): LocationDto | null {
    const city = job.city;
    const state = job.state;
    const country = job.country;
    if (!city && !state && !country) return null;
    return new LocationDto({ city, state, country });
  }

  /** Detect remote roles from the title, location, or the ad body text. */
  private detectRemote(
    title: string | null,
    entry: TempWorksListingEntry,
    descriptionHtml: string | null,
  ): boolean {
    const haystacks: Array<string | null | undefined> = [
      title,
      this.cleanText(entry.city),
      this.cleanText(entry.state),
      descriptionHtml,
    ];
    for (const field of haystacks) {
      if (typeof field !== 'string') continue;
      if (TEMPWORKS_REMOTE_REGEX.test(field)) return true;
    }
    return false;
  }

  /**
   * Split a `{city}, {state}` listing-card string into its parts. A bare value
   * with no comma is treated as the city; empty parts collapse to null.
   */
  private splitLocation(raw: string | null): { city: string | null; state: string | null } {
    const cleaned = this.cleanCardText(raw);
    if (!cleaned) return { city: null, state: null };
    const idx = cleaned.indexOf(',');
    if (idx < 0) return { city: cleaned, state: null };
    const city = cleaned.slice(0, idx).trim();
    const state = cleaned.slice(idx + 1).trim();
    return { city: city || null, state: state || null };
  }

  /** Return the leading "{title}" segment of an "{title} - {company}" string. */
  private leadingTitle(value: string | null): string | null {
    if (!value) return null;
    const cleaned = value.trim();
    if (!cleaned) return null;
    // og:title / <title> use " - " / " | " between the role and the company.
    const idx = cleaned.search(/\s[-|]\s/);
    const head = idx > 0 ? cleaned.slice(0, idx) : cleaned;
    return head.trim() || null;
  }

  /** Run a regex and return its first capture group, trimmed, or null. */
  private firstGroup(html: string, regex: RegExp): string | null {
    const match = regex.exec(html);
    if (match && typeof match[1] === 'string') {
      const v = match[1].trim();
      return v.length > 0 ? v : null;
    }
    return null;
  }

  /**
   * Trim a string and strip any inner HTML tags / collapse whitespace — listing
   * headings wrap the title in `<strong>` and the location in `<em>`. Returns
   * null for empty / non-string values.
   */
  private cleanCardText(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null;
    const stripped = value
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return stripped.length > 0 ? stripped : null;
  }

  /** Trim a string, returning null for empty / non-string values. */
  private cleanText(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null;
    const v = value.trim();
    return v.length > 0 ? v : null;
  }

  /** Decode the handful of HTML/XML entities that appear in meta tags / markup. */
  private decodeEntities(value: string): string {
    return value
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#0?39;/g, "'")
      .replace(/&apos;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .replace(/&#(\d+);/g, (_, d) => {
        const code = Number(d);
        return Number.isFinite(code) ? String.fromCodePoint(code) : _;
      })
      .replace(/&amp;/g, '&');
  }
}
