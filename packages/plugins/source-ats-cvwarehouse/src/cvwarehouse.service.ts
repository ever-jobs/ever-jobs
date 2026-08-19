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
} from '@ever-jobs/common';
import {
  CVWAREHOUSE_ROOT_DOMAIN,
  CVWAREHOUSE_BOARD_HOST,
  CVWAREHOUSE_COMPANY_PARAM,
  CVWAREHOUSE_DEFAULT_LANG,
  CVWAREHOUSE_DEFAULT_RESULTS,
  CVWAREHOUSE_DEFAULT_TIMEOUT_SECONDS,
  CVWAREHOUSE_HEADERS,
  CVWAREHOUSE_REMOTE_REGEX,
  CVWAREHOUSE_COUNTRY_CODES,
  cvwarehouseBoardUrl,
  cvwarehouseJobUrl,
  cvwarehouseApplyUrl,
} from './cvwarehouse.constants';
import { CvWarehouseBoard, CvWarehouseJob, CvWarehouseListingRow } from './cvwarehouse.types';

/**
 * CVWarehouse ATS careers scraper — generic, multi-tenant.
 *
 * CVWarehouse (cvwarehouse.com — a Belgian / EU applicant-tracking platform out of Antwerp &
 * Lisbon) powers each customer's branded, public, unauthenticated candidate-facing job board on
 * the shared host `https://jobpage.cvwarehouse.com/?companyGuid={guid}&lang={lang}`. The board
 * is **server-rendered HTML** (not a client-rendered SPA): a single GET returns the full set of
 * the tenant's open roles AND, inline in the same document, every role's complete detail block —
 * so the adapter fetches once per tenant and parses everything from that HTML:
 *
 *   - listing anchor:  <a class="jobLink" data-jobid="394655" data-titleslug="…"
 *                          href="?…&job=394655&q=…"><span>{title}</span></a>
 *   - detail block:    <div data-jobdetail-job-id="394655" data-canonical-url="…">
 *                         {full HTML body}
 *                         <a class="btn-apply" href="/ApplicationForm/AppForm?job=394655&…">…</a>
 *                      </div>
 *   - collection wrap: <div data-item-collection="jobCollection-{sectionGuid}"
 *                          data-filter-country="176" data-filter-city="…">…</div>
 *
 * The adapter resolves the tenant GUID from `companySlug` (the company GUID) or from a
 * `companyUrl` on a `jobpage.cvwarehouse.com` host (its `companyGuid` query param), GETs the
 * board HTML once, parses every role anchor + its sibling detail block, and maps each role —
 * rather than depending on a client-rendered DOM, a headless browser, or any authenticated
 * CVWarehouse API. The numeric `data-jobid` is the stable ATS id; the detail block's
 * `data-canonical-url` is the canonical public deep-link, and its apply anchor is the public
 * `/ApplicationForm/AppForm` flow.
 *
 * The caller addresses a tenant by `companySlug` (the company GUID, e.g.
 * `0875aa48-21be-43a2-b7cd-1ca7b94b2249`) or by `companyUrl` (a
 * `jobpage.cvwarehouse.com/?companyGuid={guid}` URL). An unknown GUID, a tenant with no
 * published roles, or an empty board degrades naturally to an empty result. A fetch error, an
 * HTTP 4xx / 5xx, a DNS failure, or a malformed body degrades to an empty / partial result
 * rather than throwing, so a single tenant never nukes a batch run.
 */
@SourcePlugin({
  site: Site.CVWAREHOUSE,
  name: 'CVWarehouse',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class CvWarehouseService implements IScraper {
  private readonly logger = new Logger(CvWarehouseService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for CVWarehouse scraper');
      return new JobResponseDto([]);
    }

    const companyGuid = this.resolveCompanyGuid(companySlug, input.companyUrl);
    if (!companyGuid) {
      this.logger.warn('Could not resolve a CVWarehouse tenant company GUID from input');
      return new JobResponseDto([]);
    }

    // Cap the per-request timeout so an unresponsive CVWarehouse host degrades gracefully fast
    // rather than hanging on the client's 60s default. Bound BOTH keys: the no-proxy path keys
    // off `timeout`, the proxy path off `requestTimeout`. A caller may request a shorter
    // timeout; we only cap.
    const timeoutSeconds = Math.min(
      input.requestTimeout ?? CVWAREHOUSE_DEFAULT_TIMEOUT_SECONDS,
      CVWAREHOUSE_DEFAULT_TIMEOUT_SECONDS,
    );
    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: timeoutSeconds,
      requestTimeout: timeoutSeconds,
    });
    client.setHeaders(CVWAREHOUSE_HEADERS);

    const resultsWanted = input.resultsWanted ?? CVWAREHOUSE_DEFAULT_RESULTS;
    const jobPosts: JobPostDto[] = [];

    try {
      this.logger.log(`Fetching CVWarehouse board for company GUID: ${companyGuid}`);

      // The board renders every open role of a tenant in a single server-rendered document, so
      // one fetch is sufficient. A transport-level failure (host unreachable) or an HTTP error
      // degrades to an empty result; a missing board degrades to no roles.
      const board = await this.fetchBoard(client, companyGuid);
      if (!board || board.rows.length === 0) {
        this.logger.log(`CVWarehouse tenant ${companyGuid} has no published roles`);
        return new JobResponseDto([]);
      }

      const companyName = this.cleanText(board.companyName) ?? this.deriveGuidName(companyGuid);
      const seen = new Set<string>();

      for (const row of board.rows) {
        if (jobPosts.length >= resultsWanted) break;
        try {
          const post = this.processRow(row, companyGuid, companyName, input.descriptionFormat, seen);
          if (post) jobPosts.push(post);
        } catch (err: any) {
          this.logger.warn(`Error processing CVWarehouse role ${row?.atsId}: ${err.message}`);
        }
      }

      this.logger.log(`CVWarehouse total: ${jobPosts.length} jobs for ${companyGuid}`);
      return new JobResponseDto(jobPosts);
    } catch (err: any) {
      this.logger.error(`CVWarehouse scrape error for ${companyGuid}: ${err.message}`);
      // Partial results WITH a reason: jobs.length > 0 plus a diagnostic is
      // inferred as 'partial' upstream, so a mid-scrape failure is no longer
      // indistinguishable from a complete board.
      return new JobResponseDto(jobPosts, classifyScrapeError(err));
    }
  }

  /**
   * GET the tenant's public board HTML and parse it into roles. Returns the parsed board, or
   * null when the board is unreachable / unparseable (degrade to no roles). An HTTP error status
   * (4xx / 5xx — a real, reachable host) yields an empty board; a transport-level failure (DNS /
   * connection refused / reset / timeout) returns null. Never throws.
   */
  private async fetchBoard(
    client: ReturnType<typeof createHttpClient>,
    companyGuid: string,
  ): Promise<CvWarehouseBoard | null> {
    const url = cvwarehouseBoardUrl(companyGuid, CVWAREHOUSE_DEFAULT_LANG);
    try {
      const response = await client.get<string>(url, { responseType: 'text' });
      const html = typeof response.data === 'string' ? response.data : String(response.data ?? '');
      if (!html) return { rows: [] };
      return this.parseBoard(html);
    } catch (err: any) {
      const status = err?.response?.status;
      if (status) {
        // The host answered an HTTP status (4xx / 5xx) — it is reachable, just no roles to read.
        this.logger.warn(`CVWarehouse board returned HTTP ${status} for ${companyGuid}`);
        return { rows: [] };
      }
      // No HTTP response → transport-level failure (DNS / refused / reset / timeout): the host
      // is unreachable. Degrade gracefully and signal no board.
      this.logger.warn(`CVWarehouse board fetch failed for ${companyGuid}: ${err?.message ?? err}`);
      return null;
    }
  }

  /**
   * Parse a board document's HTML into roles. Walks each role-listing anchor
   * (`a.jobLink[data-jobid]`), pairs it with its sibling detail block
   * (`[data-jobdetail-job-id]`) for the body / apply URL / canonical URL, and reads the role's
   * collection wrapper for the country / city filters. Returns an empty board on any parse
   * failure. Never throws.
   */
  private parseBoard(html: string): CvWarehouseBoard {
    try {
      const $ = cheerio.load(html);

      const companyName = this.parseCompanyName($);

      // Index every detail block by its job id so we can pair it with its listing anchor.
      const details = new Map<string, cheerio.Cheerio<any>>();
      $('[data-jobdetail-job-id]').each((_i, el) => {
        const id = this.cleanText($(el).attr('data-jobdetail-job-id'));
        if (id) details.set(id, $(el));
      });

      const rows: CvWarehouseListingRow[] = [];
      const seen = new Set<string>();

      $('a.jobLink[data-jobid]').each((_i, el) => {
        const $a = $(el);
        const atsId = this.cleanText($a.attr('data-jobid'));
        if (!atsId || seen.has(atsId)) return;
        seen.add(atsId);

        const title =
          this.cleanText($a.find('span').first().text()) ?? this.cleanText($a.text());
        const href = $a.attr('href') ?? '';
        const titleSlug =
          this.cleanText($a.attr('data-titleslug')) ?? this.slugFromHref(href);

        // Collection wrapper for the role's section / location filters.
        const $collection = $a.closest('[data-item-collection]');
        const sectionGuid = this.sectionGuidFrom($collection.attr('data-item-collection'));
        const countryCode = this.cleanText($collection.attr('data-filter-country'));
        const city = this.cleanText($collection.attr('data-filter-cityname'))
          ?? this.cleanText($collection.attr('data-filter-city'));

        // Pair the sibling detail block (body + apply URL + canonical URL).
        const $detail = details.get(atsId);
        let descriptionHtml: string | null = null;
        let canonicalUrl: string | null = null;
        let applyUrl: string | null = null;
        if ($detail) {
          descriptionHtml = this.cleanText($detail.html());
          canonicalUrl = this.cleanText($detail.attr('data-canonical-url'));
          const $apply = $detail.find('a.btn-apply, a[href*="/ApplicationForm/AppForm"]').first();
          applyUrl = this.cleanText($apply.attr('href'));
        }

        rows.push({
          atsId,
          title,
          titleSlug,
          sectionGuid,
          countryCode: this.isNumericCity(city) ? null : countryCode,
          city: this.isNumericCity(city) ? null : city,
          descriptionHtml,
          canonicalUrl,
          applyUrl,
        });
      });

      return { companyName, rows };
    } catch (err: any) {
      this.logger.warn(`CVWarehouse board parse error: ${err.message}`);
      return { rows: [] };
    }
  }

  /** Read the tenant display name from the board's Organization JSON-LD `name`, when present. */
  private parseCompanyName($: cheerio.CheerioAPI): string | null {
    let name: string | null = null;
    $('script[type="application/ld+json"]').each((_i, el) => {
      if (name) return;
      const raw = $(el).contents().text();
      if (!raw) return;
      try {
        const parsed = JSON.parse(raw);
        const candidate = Array.isArray(parsed) ? parsed[0] : parsed;
        if (candidate && typeof candidate === 'object' && typeof candidate.name === 'string') {
          name = this.cleanText(candidate.name);
        }
      } catch {
        // Non-JSON / malformed block — skip it.
      }
    });
    return name;
  }

  /** Map a parsed row → JobPostDto, deduping by ATS id. */
  private processRow(
    row: CvWarehouseListingRow,
    companyGuid: string,
    companyName: string,
    format: DescriptionFormat | undefined,
    seen: Set<string>,
  ): JobPostDto | null {
    const job = this.normaliseRow(row, companyGuid, companyName);
    if (!job) return null;
    if (seen.has(job.atsId)) return null;
    seen.add(job.atsId);
    return this.processJob(job, companyGuid, format);
  }

  /** Build a normalised CvWarehouseJob from a parsed row. */
  private normaliseRow(
    row: CvWarehouseListingRow,
    companyGuid: string,
    companyName: string,
  ): CvWarehouseJob | null {
    const atsId = this.cleanText(row.atsId);
    if (!atsId) return null;

    const title = this.cleanText(row.title);
    const slug = this.cleanText(row.titleSlug);
    const url =
      this.absoluteUrl(row.canonicalUrl) ?? cvwarehouseJobUrl(companyGuid, atsId, CVWAREHOUSE_DEFAULT_LANG, slug);
    const applyUrl =
      this.absoluteUrl(row.applyUrl) ?? cvwarehouseApplyUrl(companyGuid, atsId, CVWAREHOUSE_DEFAULT_LANG, slug);

    const city = this.cleanText(row.city);
    const country = this.countryFromCode(row.countryCode);
    const locationText = this.joinLocation(city, country);

    return {
      atsId,
      url,
      applyUrl,
      title,
      companyName: companyName ?? this.deriveGuidName(companyGuid),
      city,
      country,
      locationText,
      descriptionHtml: this.cleanText(row.descriptionHtml),
      isRemote: this.detectRemote(title, locationText, row.descriptionHtml),
    };
  }

  /** Map a normalised CvWarehouseJob → JobPostDto. */
  private processJob(
    job: CvWarehouseJob,
    companyGuid: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const title = job.title;
    if (!title) return null;

    const atsId = job.atsId;
    if (!atsId) return null;

    const jobUrl = job.url;
    if (!jobUrl) return null;

    const companyName = job.companyName ?? this.deriveGuidName(companyGuid);
    const description = this.formatDescription(job.descriptionHtml ?? null, format);

    return new JobPostDto({
      id: `cvwarehouse-${atsId}`,
      title,
      companyName,
      jobUrl,
      location: this.extractLocation(job),
      description,
      datePosted: null,
      isRemote: job.isRemote ?? false,
      emails: extractEmails(description ?? ''),
      site: Site.CVWAREHOUSE,
      atsId,
      atsType: 'cvwarehouse',
      department: null,
      employmentType: null,
      applyUrl: job.applyUrl ?? jobUrl,
    });
  }

  /**
   * Convert the role description body per `descriptionFormat`. CVWarehouse exposes the body as
   * HTML, so HTML returns it as-is, Markdown converts it, and Plain strips the tags.
   */
  private formatDescription(html: string | null, format?: DescriptionFormat): string | null {
    if (!html) return null;
    if (format === DescriptionFormat.HTML) return html;
    if (format === DescriptionFormat.MARKDOWN) return markdownConverter(html) ?? html;
    return htmlToPlainText(html) ?? html;
  }

  /**
   * Resolve the tenant company GUID. An explicit `companySlug` is treated as the company GUID (a
   * full board URL passed as the slug is reduced to its `companyGuid` param); a `companyUrl` on a
   * `jobpage.cvwarehouse.com` host has the GUID taken from its `companyGuid` query param. Returns
   * an empty string when neither yields a GUID.
   */
  private resolveCompanyGuid(
    companySlug: string | undefined,
    companyUrl: string | undefined,
  ): string {
    if (companySlug && companySlug.trim()) {
      const slug = companySlug.trim();
      // A caller may also pass a full board URL as the slug.
      if (/^https?:\/\//i.test(slug) || slug.includes(CVWAREHOUSE_ROOT_DOMAIN)) {
        const fromUrl = this.guidFromUrl(slug);
        if (fromUrl) return fromUrl;
      }
      const guid = this.normaliseGuid(slug);
      if (guid) return guid;
    }
    if (companyUrl) {
      const fromUrl = this.guidFromUrl(companyUrl);
      if (fromUrl) return fromUrl;
    }
    return '';
  }

  /**
   * Derive the tenant company GUID from a CVWarehouse board URL. The candidate-facing board is
   * `jobpage.cvwarehouse.com/?companyGuid={guid}`; the GUID is the `companyGuid` query param.
   */
  private guidFromUrl(value: string): string {
    const raw = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    try {
      const u = new URL(raw);
      const hostname = u.hostname.toLowerCase();
      // Accept the board host (jobpage.cvwarehouse.com) or any *.cvwarehouse.com host bearing a
      // companyGuid param.
      if (!hostname.endsWith(CVWAREHOUSE_ROOT_DOMAIN)) return '';
      const param = u.searchParams.get(CVWAREHOUSE_COMPANY_PARAM);
      const guid = this.normaliseGuid(param);
      if (guid) return guid;
    } catch {
      // Malformed URL — no GUID.
    }
    return '';
  }

  /** Validate + lower-case a 36-char company GUID; return null for anything that is not one. */
  private normaliseGuid(value: string | null | undefined): string {
    const cleaned = this.cleanText(value);
    if (!cleaned) return '';
    const guid = cleaned.toLowerCase();
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(guid)) {
      return guid;
    }
    return '';
  }

  /** De-slugify + title-case the tenant GUID's leading token into a display company name. */
  private deriveGuidName(companyGuid: string): string {
    // A GUID carries no human name; fall back to a neutral, stable label.
    return `Company ${companyGuid.slice(0, 8)}`;
  }

  /** Extract the `{sectionGuid}` from a `jobCollection-{sectionGuid}` collection token. */
  private sectionGuidFrom(value: string | null | undefined): string | null {
    const cleaned = this.cleanText(value);
    if (!cleaned) return null;
    const m = cleaned.match(/jobCollection-([0-9a-f-]+)/i);
    return m ? m[1] : null;
  }

  /** Resolve a numeric ISO-3166 country code into a display country, else null. */
  private countryFromCode(code: string | null | undefined): string | null {
    const cleaned = this.cleanText(code);
    if (!cleaned || !/^\d+$/.test(cleaned)) return null;
    return CVWAREHOUSE_COUNTRY_CODES[cleaned] ?? null;
  }

  /** A `data-filter-city` that is a bare numeric code is an internal id, not a city name. */
  private isNumericCity(value: string | null | undefined): boolean {
    const cleaned = this.cleanText(value);
    return !!cleaned && /^\d+$/.test(cleaned);
  }

  /** Read the title slug from a board href's `q` query param, else null. */
  private slugFromHref(href: string): string | null {
    if (!href) return null;
    try {
      const u = new URL(href, `https://${CVWAREHOUSE_BOARD_HOST}`);
      return this.cleanText(u.searchParams.get('q'));
    } catch {
      return null;
    }
  }

  /** Resolve a possibly-relative board URL into an absolute one, else null. */
  private absoluteUrl(value: string | null | undefined): string | null {
    const cleaned = this.cleanText(value);
    if (!cleaned) return null;
    try {
      return new URL(cleaned, `https://${CVWAREHOUSE_BOARD_HOST}`).toString();
    } catch {
      return null;
    }
  }

  /**
   * Surface the role's location parts as a LocationDto, leaving location null when nothing usable
   * is present.
   */
  private extractLocation(job: CvWarehouseJob): LocationDto | null {
    const city = job.city;
    const country = job.country;
    if (!city && !country) return null;
    return new LocationDto({ city, country });
  }

  /** Join the structured location parts into a single free-text line (for remote tests). */
  private joinLocation(city: string | null, country: string | null): string | null {
    const parts = [city, country].filter((p): p is string => !!p);
    return parts.length > 0 ? parts.join(', ') : null;
  }

  /** Detect remote roles from the title, location, or description text. */
  private detectRemote(
    title: string | null,
    location: string | null,
    descriptionHtml: string | null | undefined,
  ): boolean {
    const haystacks: Array<string | null | undefined> = [title, location, descriptionHtml];
    for (const field of haystacks) {
      if (typeof field !== 'string') continue;
      if (CVWAREHOUSE_REMOTE_REGEX.test(field)) return true;
    }
    return false;
  }

  /** Trim a string, returning null for empty / non-string values. */
  private cleanText(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null;
    const v = value.trim();
    return v.length > 0 ? v : null;
  }
}
