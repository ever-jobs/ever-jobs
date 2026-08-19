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
  CEIPAL_API_BASE,
  CEIPAL_JOB_POSTINGS_PATH,
  CEIPAL_PAGE_PARAM,
  CEIPAL_PAGE_SIZE,
  CEIPAL_MAX_CONCURRENCY,
  CEIPAL_REQUEST_DELAY_MS,
  CEIPAL_MAX_PAGES,
  CEIPAL_DEFAULT_RESULTS,
  CEIPAL_JOB_PAGE_TEMPLATE,
  CEIPAL_HEADERS,
} from './ceipal.constants';
import {
  CeipalJobPosting,
  CeipalJobListResponse,
  CeipalJobDetail,
  CeipalJobDetailResponse,
} from './ceipal.types';

/**
 * Ceipal public career-portal scraper — generic, multi-tenant.
 *
 * Ceipal is a US staffing / talent-acquisition ATS. Every tenant that publishes
 * a public career portal is identified by a single anonymous **career-portal
 * API key** carried in the URL path. The reference jQuery client derives the
 * API surface as `https://api.ceipal.com/{apiKey}/…`:
 *
 *   1. `GET https://api.ceipal.com/{apiKey}/job-postings/?page={n}`
 *      → DRF paginated envelope
 *        `{ status, success, count, num_pages, page_number, next, previous,
 *           results: CeipalJobPosting[] }`.
 *      The list rows already carry a short HTML description, so most runs need
 *      no detail fetch at all.
 *
 *   2. `GET https://api.ceipal.com/{apiKey}/job-postings/{id}/`
 *      → a single (optionally `data`-wrapped) record with the full description.
 *      Used only to enrich a row whose description was empty.
 *
 * The tenant key is resolved from `input.companySlug` (preferred) or from the
 * first path segment / `apiKey`-style token of `input.companyUrl`.
 *
 * Robustness: every fetch and parse is guarded. An unknown / rotated key
 * (HTTP 400 `success: 0`), a missing resource (HTTP 404), or a malformed
 * payload degrades to an empty or partial result and is logged via the NestJS
 * Logger — the scraper never throws to the caller, so a single tenant can never
 * abort a batch run. All fan-out uses `Promise.allSettled`.
 */
@SourcePlugin({
  site: Site.CEIPAL,
  name: 'Ceipal',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class CeipalService implements IScraper {
  private readonly logger = new Logger(CeipalService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    if (!input.companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for Ceipal scraper');
      return new JobResponseDto([]);
    }

    const apiKey = this.resolveApiKey(input.companySlug, input.companyUrl);
    if (!apiKey) {
      this.logger.warn('Could not resolve a Ceipal career-portal API key from input');
      return new JobResponseDto([]);
    }

    const companyName = this.deriveCompanyName(input.companySlug, input.companyUrl);

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(CEIPAL_HEADERS);

    const resultsWanted = input.resultsWanted ?? CEIPAL_DEFAULT_RESULTS;
    const seen = new Set<string>();
    const jobPosts: JobPostDto[] = [];

    try {
      this.logger.log(`Fetching Ceipal job postings for tenant key: ${this.maskKey(apiKey)}`);

      // First page → rows + true page/count metadata for this tenant.
      const first = await this.fetchListPage(client, apiKey, 1);
      if (!first) {
        this.logger.warn(`Ceipal tenant key not matched or no jobs: ${this.maskKey(apiKey)}`);
        return new JobResponseDto([]);
      }

      await this.collectRows(
        client,
        apiKey,
        first.rows,
        companyName,
        input.descriptionFormat,
        seen,
        jobPosts,
      );

      const numPages = Math.max(1, first.numPages || 1);
      const maxPage = Math.min(
        numPages,
        CEIPAL_MAX_PAGES,
        Math.ceil(resultsWanted / CEIPAL_PAGE_SIZE) || 1,
      );

      if (jobPosts.length < resultsWanted && maxPage > 1) {
        const remainingPages: number[] = [];
        for (let page = 2; page <= maxPage; page += 1) {
          remainingPages.push(page);
        }

        for (let i = 0; i < remainingPages.length; i += CEIPAL_MAX_CONCURRENCY) {
          const chunk = remainingPages.slice(i, i + CEIPAL_MAX_CONCURRENCY);
          const pageResults = await Promise.allSettled(
            chunk.map((page) => this.fetchListPage(client, apiKey, page)),
          );

          const chunkRows: CeipalJobPosting[] = [];
          for (const result of pageResults) {
            if (result.status === 'fulfilled' && result.value) {
              chunkRows.push(...result.value.rows);
            } else if (result.status === 'rejected') {
              this.logger.warn(
                `Ceipal listing page fetch failed: ${result.reason?.message ?? result.reason}`,
              );
            }
          }

          await this.collectRows(
            client,
            apiKey,
            chunkRows,
            companyName,
            input.descriptionFormat,
            seen,
            jobPosts,
          );

          if (jobPosts.length >= resultsWanted) break;

          if (i + CEIPAL_MAX_CONCURRENCY < remainingPages.length) {
            await randomSleep(CEIPAL_REQUEST_DELAY_MS, CEIPAL_REQUEST_DELAY_MS * 2);
          }
        }
      }

      const trimmed = jobPosts.slice(0, resultsWanted);
      this.logger.log(`Ceipal total: ${trimmed.length} jobs for ${companyName}`);
      return new JobResponseDto(trimmed);
    } catch (err: any) {
      this.logger.error(
        `Ceipal scrape error for ${this.maskKey(apiKey)}: ${err.message}`,
      );
      // Partial results WITH a reason: jobs.length > 0 plus a diagnostic is
      // inferred as 'partial' upstream, so a mid-scrape failure is no longer
      // indistinguishable from a complete board.
      return new JobResponseDto(jobPosts.slice(0, resultsWanted), classifyScrapeError(err));
    }
  }

  /**
   * Fetch a single listing page; returns its rows plus the tenant page count,
   * or null when the key is unmatched / the response is not a success envelope.
   */
  private async fetchListPage(
    client: ReturnType<typeof createHttpClient>,
    apiKey: string,
    page: number,
  ): Promise<{ rows: CeipalJobPosting[]; numPages: number; count: number } | null> {
    const url = `${CEIPAL_API_BASE}${encodeURIComponent(apiKey)}/${CEIPAL_JOB_POSTINGS_PATH}`;
    try {
      const response = await client.get<CeipalJobListResponse>(url, {
        params: { [CEIPAL_PAGE_PARAM]: page },
      });
      const body = response.data;
      // The API returns an HTML 404 page (string) for unknown resources, or a
      // `success: 0` envelope for an unmatched key — both are non-objects/non-1.
      if (!body || typeof body !== 'object') {
        this.logger.warn(`Ceipal: non-JSON response for key ${this.maskKey(apiKey)} page ${page}`);
        return null;
      }
      if (body.success === 0 || body.status === 400) {
        this.logger.warn(
          `Ceipal: key not matched for ${this.maskKey(apiKey)} (status=${body.status})`,
        );
        return null;
      }
      const rows: CeipalJobPosting[] = Array.isArray(body.results) ? body.results : [];
      const numPages = body.num_pages ?? 1;
      const count = body.count ?? rows.length;
      return { rows, numPages: numPages ?? 1, count: count ?? rows.length };
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 404 || status === 400) {
        this.logger.warn(`Ceipal job postings not found (HTTP ${status}) for ${this.maskKey(apiKey)}`);
        return null;
      }
      throw err;
    }
  }

  /**
   * Map a batch of listing rows into `JobPostDto`s, enriching the description
   * via the detail endpoint only when a row's description is empty. De-dupes by
   * `atsId` within the run. Detail-fetch failures degrade gracefully.
   */
  private async collectRows(
    client: ReturnType<typeof createHttpClient>,
    apiKey: string,
    rows: CeipalJobPosting[],
    companyName: string,
    format: DescriptionFormat | undefined,
    seen: Set<string>,
    out: JobPostDto[],
  ): Promise<void> {
    if (rows.length === 0) return;

    // Identify rows that need a detail fetch (no usable description on the row).
    const needsDetail = rows.map((row) => !this.rawDescription(row));
    const detailResults = await Promise.allSettled(
      rows.map((row, i) =>
        needsDetail[i] ? this.fetchJobDetail(client, apiKey, row) : Promise.resolve(null),
      ),
    );

    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      let detail: CeipalJobDetail | null = null;
      const dr = detailResults[i];
      if (dr.status === 'fulfilled') {
        detail = dr.value;
      } else {
        this.logger.warn(
          `Ceipal detail fetch failed for job ${this.rowId(row) ?? '?'}: ${dr.reason?.message ?? dr.reason}`,
        );
      }

      try {
        const post = this.processJob(row, detail, apiKey, companyName, format);
        if (!post) continue;
        const key = post.atsId as string;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(post);
      } catch (err: any) {
        this.logger.warn(`Error processing Ceipal job ${this.rowId(row) ?? '?'}: ${err.message}`);
      }
    }
  }

  /**
   * Fetch the full detail record for one job. Returns the (possibly
   * `data`-wrapped) record, or null on failure.
   */
  private async fetchJobDetail(
    client: ReturnType<typeof createHttpClient>,
    apiKey: string,
    row: CeipalJobPosting,
  ): Promise<CeipalJobDetail | null> {
    const id = this.rowId(row);
    if (!id) return null;
    const url =
      `${CEIPAL_API_BASE}${encodeURIComponent(apiKey)}/` +
      `${CEIPAL_JOB_POSTINGS_PATH}${encodeURIComponent(id)}/`;
    try {
      const response = await client.get<CeipalJobDetailResponse>(url);
      const body = response.data;
      if (!body || typeof body !== 'object') return null;
      if (body.success === 0 || body.status === 400) return null;
      // The detail body may be wrapped (`data` / `results`) or flat.
      return body.data ?? body.results ?? (body as CeipalJobDetail);
    } catch {
      return null;
    }
  }

  /** Map a listing row (+ optional detail) into a `JobPostDto`. */
  private processJob(
    row: CeipalJobPosting,
    detail: CeipalJobDetail | null,
    apiKey: string,
    companyName: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const merged: CeipalJobPosting = { ...row, ...(detail ?? {}) };

    const title =
      this.firstNonEmpty(merged.position_title, merged.job_title) ?? null;
    if (!title) return null;

    const atsId = this.rowId(merged);
    if (!atsId) return null;

    const jobUrl = this.buildJobUrl(apiKey, atsId, merged);

    const rawDescription = this.rawDescription(merged);
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

    const department =
      this.firstNonEmpty(merged.business_unit, merged.job_type, merged.primary_skills) ?? null;

    const resolvedCompanyName =
      this.firstNonEmpty(merged.client_name) ?? companyName;

    return new JobPostDto({
      id: `ceipal-${atsId}`,
      title,
      companyName: resolvedCompanyName,
      jobUrl,
      location: this.extractLocation(merged),
      description,
      datePosted: this.parseDate(merged.posted ?? merged.created),
      isRemote: this.detectRemote(merged),
      emails: extractEmails(description),
      site: Site.CEIPAL,
      atsId,
      atsType: 'ceipal',
      department,
      applyUrl: this.firstNonEmpty(merged.apply_job) ?? jobUrl,
    });
  }

  /**
   * Resolve the tenant career-portal API key from an explicit slug or a portal
   * URL. The key is an opaque hex token carried in the URL path; we accept it
   * directly as `companySlug`, or extract it from a
   * `https://api.ceipal.com/{key}/…` URL or a `?api_key=`/`?key=` query param.
   */
  private resolveApiKey(
    companySlug: string | undefined,
    companyUrl: string | undefined,
  ): string {
    if (companySlug && companySlug.trim()) return companySlug.trim();
    if (companyUrl) {
      try {
        const u = new URL(companyUrl.trim());
        const fromQuery =
          u.searchParams.get('api_key') ||
          u.searchParams.get('apiKey') ||
          u.searchParams.get('key');
        if (fromQuery && fromQuery.trim()) return fromQuery.trim();

        if (u.hostname === 'api.ceipal.com') {
          // First path segment after the host is the key.
          const seg = u.pathname.split('/').filter(Boolean)[0];
          if (seg && seg.toLowerCase() !== 'careers_v3') return seg;
        }
      } catch {
        // Malformed URL — fall through.
      }
    }
    return '';
  }

  /** Build a stable, tenant-agnostic job URL via the API detail resource. */
  private buildJobUrl(apiKey: string, atsId: string, row: CeipalJobPosting): string {
    const portalApply = this.firstNonEmpty(row.apply_job);
    if (portalApply) return portalApply;
    return CEIPAL_JOB_PAGE_TEMPLATE.replace('{key}', encodeURIComponent(apiKey)).replace(
      '{id}',
      encodeURIComponent(atsId),
    );
  }

  /** Derive a human-readable company name from the slug or portal URL. */
  private deriveCompanyName(
    companySlug: string | undefined,
    companyUrl: string | undefined,
  ): string {
    if (companyUrl) {
      try {
        const u = new URL(companyUrl.trim());
        if (u.hostname && u.hostname !== 'api.ceipal.com') {
          const host = u.hostname.replace(/^(www\.|jobs\.|careers\.|joblist\.)/, '');
          const label = host.split('.')[0];
          if (label) return this.titleCase(label);
        }
      } catch {
        // ignore
      }
    }
    if (companySlug && companySlug.trim() && !/^[a-f0-9]{16,}$/i.test(companySlug.trim())) {
      return this.titleCase(companySlug.trim());
    }
    return 'Ceipal Employer';
  }

  /** Resolve the row's id as a string from `id` or `job_id`. */
  private rowId(row: CeipalJobPosting): string | null {
    const raw = row.id ?? row.job_id;
    if (raw === null || raw === undefined) return null;
    const s = String(raw).trim();
    return s || null;
  }

  /** Best available raw HTML description for a row/detail. */
  private rawDescription(row: CeipalJobPosting): string | null {
    return this.firstNonEmpty(row.public_job_desc, row.requistion_description);
  }

  /** Extract a `LocationDto` from the city / state / country fields. */
  private extractLocation(row: CeipalJobPosting): LocationDto | null {
    const city = this.firstNonEmpty(row.city);
    const state = this.firstNonEmpty(row.state);
    const country = this.firstNonEmpty(row.country);
    if (!city && !state && !country) return null;
    return new LocationDto({ city: city ?? null, state: state ?? null, country: country ?? null });
  }

  /** Detect remote roles from an explicit flag, work type, or the title/skills. */
  private detectRemote(row: CeipalJobPosting): boolean {
    const flag = row.remote_job;
    if (flag === 1 || flag === '1' || (typeof flag === 'string' && flag.toLowerCase() === 'yes')) {
      return true;
    }
    const haystacks = [row.work_type, row.position_title, row.job_title, row.city, row.state];
    for (const field of haystacks) {
      if (typeof field !== 'string') continue;
      const v = field.toLowerCase();
      if (v.includes('remote') || v.includes('work from home') || v.includes('wfh')) return true;
    }
    return false;
  }

  /**
   * Parse a date string into a `YYYY-MM-DD` string. Tolerates ISO-8601,
   * "MM/DD/YYYY", and RFC-1123 forms. Returns null when unparseable.
   */
  private parseDate(value: string | null | undefined): string | null {
    if (!value) return null;
    const raw = value.trim();
    if (!raw) return null;
    try {
      // Normalise "YYYY-MM-DD HH:mm:ss" → ISO by swapping the space.
      const normalised = /^\d{4}-\d{2}-\d{2} /.test(raw) ? raw.replace(' ', 'T') : raw;
      const parsed = new Date(normalised);
      if (!isNaN(parsed.getTime())) return toDateOnly(normalised);
    } catch {
      // ignore
    }
    return null;
  }

  /** Return the first non-empty trimmed string from the arguments, or null. */
  private firstNonEmpty(...values: Array<string | null | undefined>): string | null {
    for (const v of values) {
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return null;
  }

  /** kebab/underscore → Title Case. */
  private titleCase(value: string): string {
    return value
      .replace(/[-_.]+/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /** Mask a key for logs (keep the first 6 chars). */
  private maskKey(key: string): string {
    if (key.length <= 6) return key;
    return `${key.slice(0, 6)}…`;
  }
}
