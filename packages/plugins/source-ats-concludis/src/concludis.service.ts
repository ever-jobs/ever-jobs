import * as cheerio from 'cheerio';
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
  randomSleep,
  toDateOnly,
} from '@ever-jobs/common';
import {
  CONCLUDIS_HOST_TEMPLATE,
  CONCLUDIS_LIST_PATH_TEMPLATE,
  CONCLUDIS_PAGE_PARAM,
  CONCLUDIS_PAGE_SIZE,
  CONCLUDIS_MAX_CONCURRENCY,
  CONCLUDIS_REQUEST_DELAY_MS,
  CONCLUDIS_DEFAULT_RESULTS,
  CONCLUDIS_MAX_PAGES,
  CONCLUDIS_ROW_SELECTOR,
  CONCLUDIS_TITLE_SELECTOR,
  CONCLUDIS_TEASER_SELECTOR,
  CONCLUDIS_COUNT_SELECTOR,
  CONCLUDIS_HEADERS,
} from './concludis.constants';
import {
  ConcludisListingRow,
  ConcludisListingResult,
  ConcludisJobPostingLd,
  ConcludisPlace,
} from './concludis.types';

/**
 * Concludis career-portal scraper — generic, multi-tenant.
 *
 * Concludis is a German e-recruiting / applicant-tracking platform. Every
 * customer tenant runs a branded public career portal under its own sub-domain
 * of `concludis.de` (e.g. `https://hwk-stuttgart.concludis.de/`). The portal
 * root 302-redirects to a server-rendered listing page that embeds every open
 * role; no client-side fetch and no authentication are required.
 *
 * Strategy:
 *   1. Resolve the tenant host from `companySlug` (preferred) or `companyUrl`.
 *   2. Fetch the listing page(s) and parse `div.stellen.list > div[id="line_*"]`
 *      rows with cheerio → title, numeric `oid` (ATS id), canonical detail URL,
 *      and a short teaser (the reliable primary record).
 *   3. Best-effort enrich each job by fetching its detail page and parsing the
 *      embedded schema.org JSON-LD `JobPosting` (full description, datePosted,
 *      structured location, employment type, hiring-organization name). Detail
 *      enrichment is fanned out with `Promise.allSettled`; any failure, redirect,
 *      empty body, or missing JSON-LD degrades to the listing teaser.
 *
 * A missing tenant, an HTTP error, or a malformed payload degrades to an
 * empty/partial result — never throws — so a single tenant never aborts a
 * batch run.
 */
@SourcePlugin({
  site: Site.CONCLUDIS,
  name: 'Concludis',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class ConcludisService implements IScraper {
  private readonly logger = new Logger(ConcludisService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    if (!input.companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for Concludis scraper');
      return new JobResponseDto([]);
    }

    const host = this.resolveHost(input.companySlug, input.companyUrl);
    if (!host) {
      this.logger.warn('Could not resolve a Concludis tenant host from input');
      return new JobResponseDto([]);
    }

    const fallbackCompanyName = this.deriveCompanyName(host, input.companySlug);

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(CONCLUDIS_HEADERS);

    const resultsWanted = input.resultsWanted ?? CONCLUDIS_DEFAULT_RESULTS;
    const seen = new Set<string>();
    const rows: ConcludisListingRow[] = [];

    try {
      this.logger.log(`Fetching Concludis listing for host: ${host}`);

      // First listing page → rows + total count for this tenant.
      const first = await this.fetchListingPage(client, host, 1);
      if (!first) {
        this.logger.warn(`Concludis tenant not found or no listing: ${host}`);
        return new JobResponseDto([]);
      }

      this.collectRows(first.rows, seen, rows);

      const total = first.total > 0 ? first.total : rows.length;
      const effectiveTotal = Math.min(total, resultsWanted);
      const lastPage = Math.min(
        CONCLUDIS_MAX_PAGES,
        Math.max(1, Math.ceil(effectiveTotal / CONCLUDIS_PAGE_SIZE)),
      );

      // Paginate through remaining listing pages until we have enough rows.
      for (
        let page = 2;
        page <= lastPage && rows.length < effectiveTotal;
        page += 1
      ) {
        const result = await this.fetchListingPage(client, host, page);
        if (!result || result.rows.length === 0) break;
        const before = rows.length;
        this.collectRows(result.rows, seen, rows);
        if (rows.length === before) break; // no new rows → avoid looping
        if (page < lastPage) {
          await randomSleep(CONCLUDIS_REQUEST_DELAY_MS, CONCLUDIS_REQUEST_DELAY_MS * 2);
        }
      }

      const wanted = rows.slice(0, resultsWanted);
      const jobPosts = await this.enrichAndMap(
        client,
        wanted,
        host,
        fallbackCompanyName,
        input.descriptionFormat,
      );

      this.logger.log(`Concludis total: ${jobPosts.length} jobs for ${fallbackCompanyName}`);
      return new JobResponseDto(jobPosts);
    } catch (err: any) {
      this.logger.error(`Concludis scrape error for ${host}: ${err.message}`);
      // Best-effort: map whatever rows we already collected, without enrichment.
      const partial = rows
        .slice(0, resultsWanted)
        .map((row) => this.mapRow(row, null, host, fallbackCompanyName, input.descriptionFormat))
        .filter((p): p is JobPostDto => p !== null);
      // Partial results WITH a reason: jobs.length > 0 plus a diagnostic is
      // inferred as 'partial' upstream, so a mid-scrape failure is no longer
      // indistinguishable from a complete board.
      return new JobResponseDto(partial, classifyScrapeError(err));
    }
  }

  /**
   * Fetch and parse a single listing page. Returns null when the tenant is
   * unknown (HTTP 404/403/400) so the caller can degrade to empty results.
   */
  private async fetchListingPage(
    client: ReturnType<typeof createHttpClient>,
    host: string,
    page: number,
  ): Promise<ConcludisListingResult | null> {
    const url = `${host}${CONCLUDIS_LIST_PATH_TEMPLATE}`;
    const params = page > 1 ? { [CONCLUDIS_PAGE_PARAM]: page } : undefined;
    try {
      const response = await client.get<string>(url, {
        params,
        responseType: 'text',
      });
      const html = typeof response.data === 'string' ? response.data : String(response.data ?? '');
      if (!html) return { total: 0, rows: [] };
      return this.parseListing(html);
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 404 || status === 403 || status === 400) {
        this.logger.warn(`Concludis listing not found (HTTP ${status}) for ${host}`);
        return null;
      }
      throw err;
    }
  }

  /**
   * Parse a listing page's HTML into rows + the reported total count.
   * Returns an empty result on any parse failure.
   */
  private parseListing(html: string): ConcludisListingResult {
    try {
      const $ = cheerio.load(html);

      const countText = $(CONCLUDIS_COUNT_SELECTOR).first().text();
      const countMatch = countText.match(/(\d[\d.,]*)/);
      const total = countMatch ? parseInt(countMatch[1].replace(/[.,]/g, ''), 10) : 0;

      const rows: ConcludisListingRow[] = [];
      $(CONCLUDIS_ROW_SELECTOR).each((_i, el) => {
        const $el = $(el);

        const idAttr = $el.attr('id') ?? '';
        const oidFromId = idAttr.replace(/^line_/, '').trim() || null;

        const onclick = $el.attr('onclick') ?? '';
        const detailUrl = this.extractDetailUrl(onclick);
        const oidFromUrl = this.extractOidFromUrl(detailUrl);

        const title = $el.find(CONCLUDIS_TITLE_SELECTOR).first().text().trim() || null;
        const teaserHtml = $el.find(CONCLUDIS_TEASER_SELECTOR).first().html()?.trim() || null;

        rows.push({
          oid: oidFromId || oidFromUrl,
          title,
          detailUrl,
          teaserHtml,
        });
      });

      return { total: isNaN(total) ? rows.length : total, rows };
    } catch (err: any) {
      this.logger.warn(`Concludis listing parse error: ${err.message}`);
      return { total: 0, rows: [] };
    }
  }

  /** Pull the detail URL out of an `cJobboard.openJob('…')` onclick handler. */
  private extractDetailUrl(onclick: string): string | null {
    if (!onclick) return null;
    const match = onclick.match(/openJob\(\s*['"]([^'"]+)['"]/i);
    if (match && match[1]) return match[1];
    // Fallback: any absolute /prj/shw/ URL in the handler.
    const urlMatch = onclick.match(/https?:\/\/[^'"\s)]*\/prj\/shw\/[^'"\s)]+/i);
    return urlMatch ? urlMatch[0] : null;
  }

  /** Extract the numeric `{oid}` segment from a `/prj/shw/{hash}_0/{oid}/…` URL. */
  private extractOidFromUrl(detailUrl: string | null): string | null {
    if (!detailUrl) return null;
    const match = detailUrl.match(/\/prj\/shw\/[^/]+\/(\d+)\//);
    return match ? match[1] : null;
  }

  /** De-dupe rows by oid and append to `out`. */
  private collectRows(
    incoming: ConcludisListingRow[],
    seen: Set<string>,
    out: ConcludisListingRow[],
  ): void {
    for (const row of incoming) {
      const key = row.oid ?? '';
      if (!key) continue;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(row);
    }
  }

  /**
   * Best-effort enrich each row with its detail-page JSON-LD, then map to
   * `JobPostDto`. Enrichment is fanned out in bounded `Promise.allSettled`
   * chunks; any per-job failure degrades to the listing teaser.
   */
  private async enrichAndMap(
    client: ReturnType<typeof createHttpClient>,
    rows: ConcludisListingRow[],
    host: string,
    fallbackCompanyName: string,
    format: DescriptionFormat | undefined,
  ): Promise<JobPostDto[]> {
    const out: JobPostDto[] = [];

    for (let i = 0; i < rows.length; i += CONCLUDIS_MAX_CONCURRENCY) {
      const chunk = rows.slice(i, i + CONCLUDIS_MAX_CONCURRENCY);
      const details = await Promise.allSettled(
        chunk.map((row) => this.fetchDetailLd(client, row)),
      );

      for (let j = 0; j < chunk.length; j += 1) {
        const row = chunk[j];
        const result = details[j];
        let ld: ConcludisJobPostingLd | null = null;
        if (result.status === 'fulfilled') {
          ld = result.value;
        } else {
          this.logger.warn(
            `Concludis detail enrich failed for oid ${row.oid}: ` +
              `${result.reason?.message ?? result.reason}`,
          );
        }
        try {
          const post = this.mapRow(row, ld, host, fallbackCompanyName, format);
          if (post) out.push(post);
        } catch (err: any) {
          this.logger.warn(`Error mapping Concludis job ${row.oid}: ${err.message}`);
        }
      }

      if (i + CONCLUDIS_MAX_CONCURRENCY < rows.length) {
        await randomSleep(CONCLUDIS_REQUEST_DELAY_MS, CONCLUDIS_REQUEST_DELAY_MS * 2);
      }
    }

    return out;
  }

  /**
   * Fetch a job detail page and extract its schema.org `JobPosting` JSON-LD.
   * Returns null on any failure (redirect, empty body, no JSON-LD) — the caller
   * degrades to listing data.
   */
  private async fetchDetailLd(
    client: ReturnType<typeof createHttpClient>,
    row: ConcludisListingRow,
  ): Promise<ConcludisJobPostingLd | null> {
    const url = row.detailUrl;
    if (!url) return null;
    try {
      const response = await client.get<string>(url, { responseType: 'text' });
      const html = typeof response.data === 'string' ? response.data : String(response.data ?? '');
      if (!html) return null;
      return this.extractJobPostingLd(html);
    } catch {
      return null;
    }
  }

  /**
   * Parse all `<script type="application/ld+json">` blocks and return the first
   * one whose `@type` is `JobPosting`. Tolerant of arrays and `@graph` wrappers.
   */
  private extractJobPostingLd(html: string): ConcludisJobPostingLd | null {
    try {
      const $ = cheerio.load(html);
      const scripts = $('script[type="application/ld+json"]');
      let found: ConcludisJobPostingLd | null = null;
      scripts.each((_i, el) => {
        if (found) return;
        const raw = $(el).contents().text();
        if (!raw || !raw.trim()) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          return;
        }
        const candidate = this.findJobPosting(parsed);
        if (candidate) found = candidate;
      });
      return found;
    } catch {
      return null;
    }
  }

  /** Recursively locate a `JobPosting` object within parsed JSON-LD. */
  private findJobPosting(node: unknown): ConcludisJobPostingLd | null {
    if (!node || typeof node !== 'object') return null;
    if (Array.isArray(node)) {
      for (const item of node) {
        const hit = this.findJobPosting(item);
        if (hit) return hit;
      }
      return null;
    }
    const obj = node as Record<string, unknown>;
    const type = obj['@type'];
    const isJobPosting =
      type === 'JobPosting' || (Array.isArray(type) && type.includes('JobPosting'));
    if (isJobPosting) return obj as ConcludisJobPostingLd;
    if (Array.isArray(obj['@graph'])) {
      return this.findJobPosting(obj['@graph']);
    }
    return null;
  }

  /** Map a listing row (+ optional JSON-LD enrichment) to a `JobPostDto`. */
  private mapRow(
    row: ConcludisListingRow,
    ld: ConcludisJobPostingLd | null,
    host: string,
    fallbackCompanyName: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const title = (row.title ?? ld?.title ?? '').trim();
    if (!title) return null;

    const atsId = (row.oid ?? '').trim();
    if (!atsId) return null;

    const jobUrl = (row.detailUrl ?? '').trim() || host;

    const rawDescription = (ld?.description?.trim() || row.teaserHtml?.trim()) ?? null;
    let description: string | null = null;
    if (rawDescription) {
      if (format === DescriptionFormat.HTML) {
        description = rawDescription;
      } else if (format === DescriptionFormat.MARKDOWN) {
        description = markdownConverter(rawDescription) ?? rawDescription;
      } else {
        description = htmlToPlainText(rawDescription);
      }
    }

    const companyName = ld?.hiringOrganization?.name?.trim() || fallbackCompanyName;
    const department = this.normalizeEmploymentType(ld?.employmentType);

    return new JobPostDto({
      id: `concludis-${atsId}`,
      title,
      companyName,
      jobUrl,
      location: this.extractLocation(ld),
      description,
      datePosted: this.parseDate(ld?.datePosted),
      isRemote: this.detectRemote(title, rawDescription, ld),
      emails: extractEmails(description),
      site: Site.CONCLUDIS,
      atsId,
      atsType: 'concludis',
      department,
      applyUrl: jobUrl,
    });
  }

  /**
   * Resolve the tenant host (scheme + host, no trailing slash) from an explicit
   * `companyUrl` or a `companySlug`. A slug that already contains a dot is
   * treated as a bare hostname; a plain slug becomes `{slug}.concludis.de`.
   */
  private resolveHost(
    companySlug: string | undefined,
    companyUrl: string | undefined,
  ): string {
    if (companyUrl && companyUrl.trim()) {
      try {
        const u = new URL(companyUrl.trim());
        return `${u.protocol}//${u.host}`;
      } catch {
        // Fall through to slug-based resolution.
      }
    }

    if (companySlug && companySlug.trim()) {
      const slug = companySlug.trim();
      if (slug.includes('.')) {
        return `https://${slug}`;
      }
      return CONCLUDIS_HOST_TEMPLATE.replace('{tenant}', encodeURIComponent(slug));
    }

    return '';
  }

  /** Derive a human-readable company name from the host or slug (fallback). */
  private deriveCompanyName(host: string, companySlug: string | undefined): string {
    if (companySlug && companySlug.trim()) {
      return this.humanize(companySlug.trim().split('.')[0]);
    }
    try {
      const u = new URL(host);
      const label = u.host.replace(/^(www\.|jobs\.|careers\.|karriere\.)/, '').split('.')[0];
      return this.humanize(label);
    } catch {
      return 'Concludis Employer';
    }
  }

  private humanize(label: string): string {
    return label.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /**
   * Extract a `LocationDto` from the JSON-LD `jobLocation` (single or array).
   * Uses the first Place's `PostalAddress`. Returns null when absent.
   */
  private extractLocation(ld: ConcludisJobPostingLd | null): LocationDto | null {
    if (!ld?.jobLocation) return null;
    const place: ConcludisPlace | undefined = Array.isArray(ld.jobLocation)
      ? ld.jobLocation[0]
      : ld.jobLocation;
    const address = place?.address;
    if (!address) return null;
    const city = address.addressLocality?.trim() || null;
    const state = address.addressRegion?.trim() || null;
    const country = address.addressCountry?.trim() || null;
    if (!city && !state && !country) return null;
    return new LocationDto({ city, state, country });
  }

  /** Map schema.org employment type(s) to a single human-readable label. */
  private normalizeEmploymentType(
    employmentType: string | string[] | null | undefined,
  ): string | null {
    if (!employmentType) return null;
    const value = Array.isArray(employmentType) ? employmentType[0] : employmentType;
    if (!value) return null;
    const map: Record<string, string> = {
      FULL_TIME: 'Full Time',
      PART_TIME: 'Part Time',
      CONTRACTOR: 'Contractor',
      TEMPORARY: 'Temporary',
      INTERN: 'Internship',
      VOLUNTEER: 'Volunteer',
      PER_DIEM: 'Per Diem',
      OTHER: 'Other',
    };
    return map[value.toUpperCase()] ?? value;
  }

  /** Detect remote roles from the title, description, or employment type. */
  private detectRemote(
    title: string,
    description: string | null,
    ld: ConcludisJobPostingLd | null,
  ): boolean {
    const haystacks = [title, description ?? '', this.employmentTypeString(ld)];
    for (const field of haystacks) {
      const v = field.toLowerCase();
      if (
        v.includes('remote') ||
        v.includes('homeoffice') ||
        v.includes('home office') ||
        v.includes('home-office') ||
        v.includes('telearbeit') ||
        v.includes('work from home') ||
        v.includes('mobiles arbeiten')
      ) {
        return true;
      }
    }
    return false;
  }

  private employmentTypeString(ld: ConcludisJobPostingLd | null): string {
    const t = ld?.employmentType;
    if (!t) return '';
    return Array.isArray(t) ? t.join(' ') : t;
  }

  /**
   * Parse an ISO date (`"2026-06-01"`) or ISO datetime into a `YYYY-MM-DD`
   * string. Returns null for null/undefined or unparseable inputs.
   */
  private parseDate(value: string | null | undefined): string | null {
    if (!value) return null;
    try {
      const parsed = new Date(value.trim());
      if (!isNaN(parsed.getTime())) return toDateOnly(value.trim());
    } catch {
      // ignore
    }
    return null;
  }
}
