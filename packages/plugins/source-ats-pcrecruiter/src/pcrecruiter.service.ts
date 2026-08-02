import * as cheerio from 'cheerio';
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
  randomSleep,
  toDateOnly,
} from '@ever-jobs/common';
import {
  PCRECRUITER_BOARD_BASE,
  PCRECRUITER_JOBBOARD_PATH,
  PCRECRUITER_DEFAULT_HOST,
  PCRECRUITER_PAGE_SIZE,
  PCRECRUITER_MAX_CONCURRENCY,
  PCRECRUITER_MAX_PAGES,
  PCRECRUITER_REQUEST_DELAY_MS,
  PCRECRUITER_DEFAULT_RESULTS,
  PCRECRUITER_JOBLIST_SELECTOR,
  PCRECRUITER_TITLE_LINK_SELECTOR,
  PCRECRUITER_LOCATION_SELECTOR,
  PCRECRUITER_DATE_SELECTOR,
  PCRECRUITER_JSONLD_SELECTOR,
  PCRECRUITER_DESC_SELECTOR,
  PCRECRUITER_DESC_START_MARKER,
  PCRECRUITER_DESC_END_MARKER,
  PCRECRUITER_HEADERS,
} from './pcrecruiter.constants';
import {
  PCRecruiterListingItem,
  PCRecruiterJobDetail,
  PCRecruiterJob,
  PCRecruiterJsonLdJobPosting,
  PCRecruiterJsonLdPlace,
  PCRecruiterPagingState,
} from './pcrecruiter.types';

/**
 * PCRecruiter ATS public job board scraper — generic, multi-tenant.
 *
 * PCRecruiter (Main Sequence Technology) is a US staffing/recruiting ATS. Each
 * customer database exposes an anonymous job board at
 * `https://www2.pcrecruiter.net/pcrbin/jobboard.aspx`, identified either by a
 * human-readable `uid` (`{Display Name}.{databasename}`) or by an opaque,
 * server-issued `pcr-id` SessionID token.
 *
 * There is no public JSON API — the board is server-rendered ASP.NET HTML. The
 * adapter:
 *   1. Fetches the listing page and parses each `<table id="joblist">` row for
 *      the record id, title, location, and date posted, plus a fresh `pcr-id`
 *      token and `unifiedsearch` cursor used for pagination.
 *   2. Fans out (bounded `Promise.allSettled`) to each job's detail page and
 *      extracts the embedded schema.org `JobPosting` JSON-LD (full HTML
 *      description, employer name, structured location, employment type,
 *      datePosted), falling back to the `#jobdesc` HTML block when JSON-LD is
 *      absent.
 *   3. Best-effort pages through additional listing pages via the board's
 *      pagination POST while results are still wanted.
 *
 * Tenant resolution: `companySlug` carries the `uid` value; `companyUrl` is a
 * full board URL used verbatim. A missing tenant, an HTTP error, or a malformed
 * payload degrades to an empty/partial result — never throws — so a single
 * tenant never aborts a batch run.
 */
@SourcePlugin({
  site: Site.PCRECRUITER,
  name: 'PCRecruiter',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class PCRecruiterService implements IScraper {
  private readonly logger = new Logger(PCRecruiterService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    if (!input.companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for PCRecruiter scraper');
      return new JobResponseDto([]);
    }

    const boardUrl = this.resolveBoardUrl(input.companySlug, input.companyUrl);
    if (!boardUrl) {
      this.logger.warn('Could not resolve a PCRecruiter board URL from input');
      return new JobResponseDto([]);
    }

    const host = this.resolveHost(boardUrl);
    const companyName = this.deriveCompanyName(input.companySlug, input.companyUrl);

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(PCRECRUITER_HEADERS);

    const resultsWanted = input.resultsWanted ?? PCRECRUITER_DEFAULT_RESULTS;
    const seen = new Set<string>();
    const jobPosts: JobPostDto[] = [];

    try {
      this.logger.log(`Fetching PCRecruiter board: ${boardUrl}`);

      // First page — parse listing rows, learn the total count + paging tokens.
      const firstHtml = await this.fetchListingHtml(client, boardUrl);
      if (!firstHtml) {
        this.logger.warn(`PCRecruiter: no listing HTML for ${boardUrl}`);
        return new JobResponseDto([]);
      }

      const firstItems = this.parseListing(firstHtml, host);
      const paging = this.parsePagingState(firstHtml);

      await this.collectItems(firstItems, host, companyName, input.descriptionFormat, client, seen, jobPosts);

      const total = paging.total ?? firstItems.length;
      const effectiveTotal = Math.min(total, resultsWanted);

      // Best-effort pagination via the board POST while more results are wanted.
      if (jobPosts.length < effectiveTotal && firstItems.length >= PCRECRUITER_PAGE_SIZE && paging.pcrId) {
        const maxPage = Math.min(
          PCRECRUITER_MAX_PAGES,
          Math.ceil(effectiveTotal / PCRECRUITER_PAGE_SIZE),
        );

        for (let pageIndex = 1; pageIndex < maxPage; pageIndex += 1) {
          if (jobPosts.length >= effectiveTotal) break;

          const pageHtml = await this.fetchListingPage(client, host, paging, pageIndex);
          if (!pageHtml) break;

          const pageItems = this.parseListing(pageHtml, host);
          if (pageItems.length === 0) break;

          await this.collectItems(
            pageItems,
            host,
            companyName,
            input.descriptionFormat,
            client,
            seen,
            jobPosts,
          );

          // Refresh paging tokens from the latest page (the cursor advances).
          const nextPaging = this.parsePagingState(pageHtml);
          if (nextPaging.pcrId) paging.pcrId = nextPaging.pcrId;
          if (nextPaging.unifiedSearch) paging.unifiedSearch = nextPaging.unifiedSearch;

          if (pageIndex + 1 < maxPage) {
            await randomSleep(PCRECRUITER_REQUEST_DELAY_MS, PCRECRUITER_REQUEST_DELAY_MS * 2);
          }
        }
      }

      const trimmed = jobPosts.slice(0, resultsWanted);
      this.logger.log(`PCRecruiter total: ${trimmed.length} jobs for ${companyName}`);
      return new JobResponseDto(trimmed);
    } catch (err: any) {
      this.logger.error(`PCRecruiter scrape error for ${boardUrl}: ${err.message}`);
      return new JobResponseDto(jobPosts.slice(0, resultsWanted)); // partial results
    }
  }

  /** GET the first listing page; returns the HTML, or null on a 4xx/empty body. */
  private async fetchListingHtml(
    client: ReturnType<typeof createHttpClient>,
    boardUrl: string,
  ): Promise<string | null> {
    try {
      const response = await client.get<string>(boardUrl, { responseType: 'text' });
      const html = typeof response.data === 'string' ? response.data : String(response.data ?? '');
      return html || null;
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 400 || status === 403 || status === 404 || status === 410) {
        this.logger.warn(`PCRecruiter board not found (HTTP ${status}) for ${boardUrl}`);
        return null;
      }
      throw err;
    }
  }

  /**
   * POST the pagination form to fetch a subsequent listing page.
   * `pageIndex` is 0-based (0 = first page). Returns the HTML, or null on error.
   */
  private async fetchListingPage(
    client: ReturnType<typeof createHttpClient>,
    host: string,
    paging: PCRecruiterPagingState,
    pageIndex: number,
  ): Promise<string | null> {
    const url = `${host}${PCRECRUITER_JOBBOARD_PATH}`;
    const body = new URLSearchParams();
    body.set('action', '');
    body.set('showjobs', 'Y');
    body.set('pcr-id', paging.pcrId ?? '');
    body.set('morecount', `${pageIndex * PCRECRUITER_PAGE_SIZE}$$${pageIndex}`);
    body.set('sortorder', '');
    if (paging.unifiedSearch) body.set('unifiedsearch', paging.unifiedSearch);

    try {
      const response = await client.post<string>(url, body.toString(), {
        responseType: 'text',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });
      const html = typeof response.data === 'string' ? response.data : String(response.data ?? '');
      return html || null;
    } catch (err: any) {
      this.logger.warn(`PCRecruiter pagination fetch failed (page ${pageIndex}): ${err.message}`);
      return null;
    }
  }

  /**
   * Parse all job rows from a listing page. Each job lives in its own
   * `<table id="joblist">`; extract the record id from the title anchor's
   * `recordid` query param, plus the title, location, and date cells.
   */
  private parseListing(html: string, host: string): PCRecruiterListingItem[] {
    const items: PCRecruiterListingItem[] = [];
    let $: cheerio.CheerioAPI;
    try {
      $ = cheerio.load(html);
    } catch (err: any) {
      this.logger.warn(`PCRecruiter: listing HTML parse error: ${err.message}`);
      return items;
    }

    $(PCRECRUITER_JOBLIST_SELECTOR).each((_i, table) => {
      try {
        const $table = $(table);
        const anchor = $table.find(PCRECRUITER_TITLE_LINK_SELECTOR).first();
        if (!anchor.length) return;

        const href = anchor.attr('href') ?? '';
        const recordId = this.extractRecordId(href);
        if (!recordId) return;

        const title = anchor.text().trim();
        if (!title) return;

        const detailUrl = href.startsWith('http')
          ? href
          : `${host}${href.startsWith('/') ? '' : '/'}${href}`;

        const location = $table.find(PCRECRUITER_LOCATION_SELECTOR).first().text().trim() || null;
        const datePosted = $table.find(PCRECRUITER_DATE_SELECTOR).first().text().trim() || null;

        items.push({ recordId, title, detailUrl, location, datePosted });
      } catch (err: any) {
        this.logger.warn(`PCRecruiter: error parsing job row: ${err.message}`);
      }
    });

    return items;
  }

  /** Extract the `recordid` value from a detail-link href. */
  private extractRecordId(href: string): string | null {
    const match = href.match(/[?&]recordid=([^&]+)/i);
    return match ? decodeURIComponent(match[1]) : null;
  }

  /**
   * Extract pagination state from the listing page: the fresh `pcr-id` token,
   * the `unifiedsearch` cursor, and the reported total count.
   */
  private parsePagingState(html: string): PCRecruiterPagingState {
    const state: PCRecruiterPagingState = {};
    try {
      const $ = cheerio.load(html);

      // Total: "<h1 id="resultcount">1-24 of 38</h1>"
      const countText = $('#resultcount').first().text().trim();
      const countMatch = countText.match(/of\s+(\d+)/i);
      if (countMatch) state.total = parseInt(countMatch[1], 10);

      // Fresh pcr-id token (multiple hidden inputs share the name; take the first).
      const pcrId = $('input[name="pcr-id"]').first().attr('value');
      if (pcrId) state.pcrId = pcrId.trim();

      // unifiedsearch cursor lives in the pagination form.
      const unified = $('input[name="unifiedsearch"]').first().attr('value');
      if (unified) state.unifiedSearch = unified;
    } catch (err: any) {
      this.logger.warn(`PCRecruiter: paging-state parse error: ${err.message}`);
    }
    return state;
  }

  /**
   * For each listing item, fetch its detail page (bounded concurrent fan-out)
   * to enrich with the JSON-LD JobPosting, then map to JobPostDto. De-dupes by
   * record id within this run. Detail-fetch failures degrade gracefully — the
   * listing data alone still yields a partial JobPostDto.
   */
  private async collectItems(
    items: PCRecruiterListingItem[],
    host: string,
    companyName: string,
    format: DescriptionFormat | undefined,
    client: ReturnType<typeof createHttpClient>,
    seen: Set<string>,
    out: JobPostDto[],
  ): Promise<void> {
    const fresh = items.filter((item) => item.recordId && !seen.has(item.recordId));
    if (fresh.length === 0) return;

    for (let i = 0; i < fresh.length; i += PCRECRUITER_MAX_CONCURRENCY) {
      const chunk = fresh.slice(i, i + PCRECRUITER_MAX_CONCURRENCY);
      const settled = await Promise.allSettled(
        chunk.map(async (item) => {
          const detail = item.detailUrl
            ? await this.fetchDetail(client, item.detailUrl)
            : null;
          return { item, detail };
        }),
      );

      for (const result of settled) {
        if (result.status === 'rejected') {
          this.logger.warn(
            `PCRecruiter: item processing error: ${result.reason?.message ?? result.reason}`,
          );
          continue;
        }
        const { item, detail } = result.value;
        if (!item.recordId || seen.has(item.recordId)) continue;
        try {
          const merged: PCRecruiterJob = { ...item, ...(detail ?? {}) };
          const post = this.mapToJobPost(merged, host, companyName, format);
          if (!post) continue;
          seen.add(item.recordId);
          out.push(post);
        } catch (err: any) {
          this.logger.warn(`PCRecruiter: error mapping job ${item.recordId}: ${err.message}`);
        }
      }
    }
  }

  /**
   * Fetch and parse a detail page. Returns the JSON-LD-derived fields (with an
   * HTML-description fallback), or null on error.
   */
  private async fetchDetail(
    client: ReturnType<typeof createHttpClient>,
    detailUrl: string,
  ): Promise<PCRecruiterJobDetail | null> {
    try {
      const response = await client.get<string>(detailUrl, { responseType: 'text' });
      const html = typeof response.data === 'string' ? response.data : String(response.data ?? '');
      if (!html) return null;
      return this.parseDetail(html, detailUrl);
    } catch (err: any) {
      this.logger.warn(`PCRecruiter: detail fetch failed for ${detailUrl}: ${err.message}`);
      return null;
    }
  }

  /**
   * Parse a detail page. Prefers the embedded schema.org `JobPosting` JSON-LD;
   * falls back to the `#jobdesc` HTML block (between the pcr-description
   * marker comments) for the description.
   */
  private parseDetail(html: string, detailUrl: string): PCRecruiterJobDetail {
    const detail: PCRecruiterJobDetail = {};
    let $: cheerio.CheerioAPI;
    try {
      $ = cheerio.load(html);
    } catch (err: any) {
      this.logger.warn(`PCRecruiter: detail HTML parse error: ${err.message}`);
      return detail;
    }

    // Primary path: JSON-LD JobPosting.
    const jsonLd = this.extractJobPostingJsonLd($);
    if (jsonLd) {
      detail.title = this.clean(jsonLd.title);
      detail.descriptionHtml = jsonLd.description?.trim() || null;
      detail.datePosted = this.clean(jsonLd.datePosted);
      detail.employmentType = this.clean(jsonLd.employmentType);
      detail.companyName = this.clean(jsonLd.hiringOrganization?.name);

      const place = this.firstPlace(jsonLd.jobLocation);
      const addr = place?.address;
      if (addr) {
        detail.city = this.clean(addr.addressLocality);
        detail.state = this.clean(addr.addressRegion);
        detail.postalCode = this.clean(addr.postalCode);
        detail.country = this.clean(addr.addressCountry);
      }
    }

    // Fallback / supplement: HTML description block.
    if (!detail.descriptionHtml) {
      detail.descriptionHtml = this.extractDescriptionHtml($, html);
    }

    // Apply URL: the detail page with ?apply=y appended.
    detail.applyUrl = this.buildApplyUrl(detailUrl);

    return detail;
  }

  /**
   * Find and parse the schema.org `JobPosting` JSON-LD block. There may be
   * several `application/ld+json` scripts; pick the one whose `@type` is
   * `JobPosting`. Returns null when none parse.
   */
  private extractJobPostingJsonLd(
    $: cheerio.CheerioAPI,
  ): PCRecruiterJsonLdJobPosting | null {
    let found: PCRecruiterJsonLdJobPosting | null = null;
    $(PCRECRUITER_JSONLD_SELECTOR).each((_i, el) => {
      if (found) return;
      const raw = $(el).contents().text().trim();
      if (!raw || !/JobPosting/i.test(raw)) return;
      try {
        const parsed = JSON.parse(raw) as PCRecruiterJsonLdJobPosting | PCRecruiterJsonLdJobPosting[];
        const candidates = Array.isArray(parsed) ? parsed : [parsed];
        for (const c of candidates) {
          const type = c?.['@type'];
          if (type === 'JobPosting' || (typeof type === 'string' && type.includes('JobPosting'))) {
            found = c;
            return;
          }
        }
      } catch {
        // Malformed JSON-LD — ignore and try the next script / fallback.
      }
    });
    return found;
  }

  /** Normalise `jobLocation` (single Place or array) to its first Place. */
  private firstPlace(
    jobLocation: PCRecruiterJsonLdPlace | PCRecruiterJsonLdPlace[] | null | undefined,
  ): PCRecruiterJsonLdPlace | null {
    if (!jobLocation) return null;
    if (Array.isArray(jobLocation)) return jobLocation[0] ?? null;
    return jobLocation;
  }

  /**
   * Extract the description HTML from the `#jobdesc` block, preferring the
   * content between the `pcr-description-start`/`-end` marker comments.
   */
  private extractDescriptionHtml($: cheerio.CheerioAPI, html: string): string | null {
    const block = $(PCRECRUITER_DESC_SELECTOR).first();
    if (block.length) {
      const inner = block.html();
      if (inner && inner.trim()) {
        const start = inner.indexOf(PCRECRUITER_DESC_START_MARKER);
        const end = inner.indexOf(PCRECRUITER_DESC_END_MARKER);
        if (start !== -1 && end !== -1 && end > start) {
          const sliced = inner.substring(start + PCRECRUITER_DESC_START_MARKER.length, end).trim();
          if (sliced) return sliced;
        }
        return inner.trim();
      }
    }

    // Last-resort raw-string slice between the markers (in case cheerio dropped them).
    const rawStart = html.indexOf(PCRECRUITER_DESC_START_MARKER);
    const rawEnd = html.indexOf(PCRECRUITER_DESC_END_MARKER);
    if (rawStart !== -1 && rawEnd !== -1 && rawEnd > rawStart) {
      const sliced = html.substring(rawStart + PCRECRUITER_DESC_START_MARKER.length, rawEnd).trim();
      if (sliced) return sliced;
    }
    return null;
  }

  /** Map a merged listing+detail record to a JobPostDto; null when unusable. */
  private mapToJobPost(
    job: PCRecruiterJob,
    host: string,
    companyName: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const title = (job.title ?? '').trim();
    if (!title) return null;

    const atsId = (job.recordId ?? '').trim();
    if (!atsId) return null;

    const jobUrl = job.detailUrl
      ?? `${host}${PCRECRUITER_JOBBOARD_PATH}?action=detail&recordid=${encodeURIComponent(atsId)}`;
    const applyUrl = job.applyUrl ?? this.buildApplyUrl(jobUrl);

    const rawDescription = job.descriptionHtml ?? null;
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

    const resolvedCompanyName = (job.companyName ?? '').trim() || companyName;
    const department = (job.employmentType ?? '').trim() || null;

    return new JobPostDto({
      id: `pcrecruiter-${atsId}`,
      title,
      companyName: resolvedCompanyName,
      jobUrl,
      location: this.extractLocation(job),
      description,
      datePosted: this.parseDate(job.datePosted),
      isRemote: this.detectRemote(job),
      emails: extractEmails(description),
      site: Site.PCRECRUITER,
      atsId,
      atsType: 'pcrecruiter',
      department,
      applyUrl,
    });
  }

  /**
   * Resolve the board URL. `companyUrl` (a full board URL) is used verbatim;
   * otherwise `companySlug` is treated as the `uid` value on the default host.
   */
  private resolveBoardUrl(
    companySlug: string | undefined,
    companyUrl: string | undefined,
  ): string {
    if (companyUrl && companyUrl.trim()) {
      try {
        // Validate it is a parseable URL; use verbatim.
        const u = new URL(companyUrl.trim());
        return u.toString();
      } catch {
        // Fall through to slug-based resolution.
      }
    }
    if (companySlug && companySlug.trim()) {
      const uid = companySlug.trim();
      // If the slug already looks like a full URL, use it verbatim.
      if (/^https?:\/\//i.test(uid)) {
        try {
          return new URL(uid).toString();
        } catch {
          // ignore
        }
      }
      return `${PCRECRUITER_BOARD_BASE}?uid=${encodeURIComponent(uid)}`;
    }
    return '';
  }

  /** Resolve the scheme+host origin of the board URL (for building detail URLs). */
  private resolveHost(boardUrl: string): string {
    try {
      const u = new URL(boardUrl);
      return `${u.protocol}//${u.host}`;
    } catch {
      return PCRECRUITER_DEFAULT_HOST;
    }
  }

  /** Append `?apply=y` (or `&apply=y`) to a detail URL to form the apply URL. */
  private buildApplyUrl(detailUrl: string): string {
    const sep = detailUrl.includes('?') ? '&' : '?';
    return `${detailUrl}${sep}apply=y`;
  }

  /**
   * Derive a human-readable company name from the `uid` slug or the board URL.
   * The `uid` is `{Display Name}.{databasename}` — prefer the display-name part.
   */
  private deriveCompanyName(
    companySlug: string | undefined,
    companyUrl: string | undefined,
  ): string {
    const uidFromUrl = this.extractUidFromUrl(companyUrl);
    const uid = (companySlug && companySlug.trim()) || uidFromUrl || '';
    if (uid) {
      // "Alliance Staffing.alliancestaffing" → "Alliance Staffing"
      const displayPart = uid.split('.')[0].trim();
      if (displayPart) {
        return displayPart
          .replace(/[-_]+/g, ' ')
          .replace(/\s+/g, ' ')
          .replace(/\b\w/g, (c) => c.toUpperCase())
          .trim();
      }
    }
    if (companyUrl) {
      try {
        const host = new URL(companyUrl).host.replace(/^(www\d*\.|host\.)/, '');
        return host.split('.')[0].replace(/\b\w/g, (c) => c.toUpperCase());
      } catch {
        // ignore
      }
    }
    return 'PCRecruiter Employer';
  }

  /** Pull the `uid` query param out of a board URL, if present. */
  private extractUidFromUrl(companyUrl: string | undefined): string | null {
    if (!companyUrl) return null;
    try {
      const u = new URL(companyUrl);
      return u.searchParams.get('uid');
    } catch {
      return null;
    }
  }

  /**
   * Build a LocationDto. Prefers the structured JSON-LD address fields; falls
   * back to splitting the free-text listing location ("City, ST ZIP").
   */
  private extractLocation(job: PCRecruiterJob): LocationDto | null {
    // Structured (from JSON-LD) takes priority.
    if (job.city || job.state || job.country) {
      return new LocationDto({
        city: job.city ?? null,
        state: job.state ?? null,
        country: this.normaliseCountry(job.country),
      });
    }

    // Fallback: free-text "City, ST ZIP" listing label.
    const raw = job.location?.trim();
    if (!raw) return null;
    const parts = raw.split(',').map((p) => p.trim()).filter(Boolean);
    if (parts.length === 0) return null;
    if (parts.length === 1) {
      return new LocationDto({ city: parts[0], state: null, country: null });
    }
    const city = parts[0];
    // Second part is typically "ST ZIP" — take the leading state token.
    const stateZip = parts[1];
    const stateMatch = stateZip.match(/^([A-Za-z]{2,})\b/);
    const state = stateMatch ? stateMatch[1] : stateZip;
    return new LocationDto({ city: city ?? null, state: state ?? null, country: null });
  }

  /** Normalise a JSON-LD country to a short, consistent label. */
  private normaliseCountry(country: string | null | undefined): string | null {
    const c = country?.trim();
    if (!c) return null;
    if (/united states/i.test(c) || c.toUpperCase() === 'USA' || c.toUpperCase() === 'US') {
      return 'United States';
    }
    return c;
  }

  /** Detect remote roles from the title, location, or employment-type fields. */
  private detectRemote(job: PCRecruiterJob): boolean {
    const haystacks = [job.title, job.location, job.city, job.employmentType];
    for (const field of haystacks) {
      if (typeof field !== 'string') continue;
      const v = field.toLowerCase();
      if (v.includes('remote') || v.includes('work from home') || v.includes('wfh')) return true;
    }
    return false;
  }

  /**
   * Parse a date into a `YYYY-MM-DD` string. Handles the JSON-LD ISO form
   * ("2026-05-29") and the listing's US display form ("5/29/2026").
   * Returns null for null/undefined or unparseable inputs.
   */
  private parseDate(value: string | null | undefined): string | null {
    if (!value) return null;
    const v = value.trim();
    if (!v) return null;
    try {
      // ISO "YYYY-MM-DD".
      if (/^\d{4}-\d{2}-\d{2}/.test(v)) {
        const parsed = new Date(v);
        if (!isNaN(parsed.getTime())) return toDateOnly(v);
      }
      // US "M/D/YYYY".
      const us = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
      if (us) {
        const [, mm, dd, yy] = us;
        const fullYear = yy.length === 2 ? `20${yy}` : yy;
        const d = new Date(`${fullYear}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}T00:00:00Z`);
        if (!isNaN(d.getTime())) return toDateOnly(`${fullYear}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}T00:00:00Z`);
      }
      // Generic fallback.
      const parsed = new Date(v);
      if (!isNaN(parsed.getTime())) return toDateOnly(v);
    } catch {
      // ignore
    }
    return null;
  }

  /** Trim a string-ish value to a non-empty string or null. */
  private clean(value: string | null | undefined): string | null {
    const v = value?.trim();
    return v ? v : null;
  }
}
