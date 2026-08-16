import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import { classifyScrapeError,
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
  parseLocationText,
  jobPostingLdFromNode,
  jobPostingLdToCompensation,
  resolveCompensation,
  type JobPostingLd,
} from '@ever-jobs/common';
import {
  PAYCOM_ROOT_DOMAIN,
  PAYCOM_ALT_DOMAINS,
  PAYCOM_API_ORIGIN,
  PAYCOM_API_SEARCH_PATH,
  PAYCOM_API_DETAIL_PATH,
  PAYCOM_API_COMPANY_NAME_PATH,
  PAYCOM_SESSION_JWT_REGEX,
  PAYCOM_SEARCH_FILTERS,
  PAYCOM_REMOTE_TYPE_CODES,
  PAYCOM_REMOTE_REGEX,
  PAYCOM_PORTAL_CLIENTKEY_REGEX,
  PAYCOM_QUERY_CLIENTKEY_REGEX,
  PAYCOM_CLIENTKEY_TOKEN_REGEX,
  PAYCOM_DEFAULT_RESULTS,
  PAYCOM_HEADERS,
  paycomBoardUrl,
  paycomJobUrl,
} from './paycom.constants';
import {
  PaycomCompanyNameResponse,
  PaycomDetailResponse,
  PaycomJob,
  PaycomJobPosting,
  PaycomJobPreview,
  PaycomSearchResponse,
} from './paycom.types';

/**
 * Paycom ATS careers scraper — generic, multi-tenant.
 *
 * Paycom (paycom.com, US) serves a public, clientkey-addressed careers board
 * from `paycomonline.net`. The board is a client-rendered React app, so the
 * adapter resolves the tenant's `clientkey`, fetches the board page to read the
 * public bearer the app boots (`configsFromHost.sessionJWT`), and then talks to
 * the applicant-tracking JSON API:
 *
 *  - `POST /api/ats/job-posting-previews/search` (with the full
 *    `filtersForQuery` object) enumerates open roles (`jobPostingPreviews[]`);
 *  - `GET  /api/ats/job-postings/{id}` returns each role wrapped in `jobPosting`
 *    (full HTML body + `googleJobJson` schema.org node carrying `datePosted`,
 *    the canonical URL, and any structured `baseSalary`);
 *  - `GET  /api/ats/company-name` returns the tenant display name.
 *
 * The caller addresses a tenant by `companySlug` (the bare `clientkey`) or by
 * `companyUrl` (a board URL carrying the clientkey in its `/portal/{KEY}/` path
 * or a `?clientkey=…` query). A single fetch error, an unknown clientkey
 * (HTTP 4xx), a missing token, or a malformed payload degrades to an empty /
 * partial result rather than throwing, so a single tenant never nukes a batch.
 */
@SourcePlugin({
  site: Site.PAYCOM,
  name: 'Paycom',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class PaycomService implements IScraper {
  private readonly logger = new Logger(PaycomService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    if (!input.companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for Paycom scraper');
      return new JobResponseDto([]);
    }

    const clientkey = this.resolveClientKey(input.companySlug, input.companyUrl);
    if (!clientkey) {
      this.logger.warn('Could not resolve a Paycom clientkey from input');
      return new JobResponseDto([]);
    }

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(PAYCOM_HEADERS);

    const resultsWanted = input.resultsWanted ?? PAYCOM_DEFAULT_RESULTS;
    const jobPosts: JobPostDto[] = [];

    try {
      this.logger.log(`Fetching Paycom board for clientkey: ${clientkey}`);

      // Read the public bearer the React board boots for its own API calls.
      const board = await this.fetchBoard(client, paycomBoardUrl(clientkey));
      const token = board ? this.extractToken(board) : null;
      if (!token) {
        this.logger.warn(`No Paycom sessionJWT found for clientkey ${clientkey}`);
        return new JobResponseDto([]);
      }
      const auth = { Authorization: `Bearer ${token}` };

      // The display name is behind its own endpoint (not the clientkey).
      const companyName = await this.fetchCompanyName(client, auth);

      const previews = await this.fetchPreviews(client, auth, resultsWanted);
      const seen = new Set<string>();
      const wanted = previews
        .map((preview) => ({ preview, atsId: this.previewId(preview) }))
        .filter((x) => x.atsId && !seen.has(x.atsId) && seen.add(x.atsId))
        .slice(0, resultsWanted);

      for (const { preview, atsId } of wanted) {
        try {
          const posting = await this.fetchDetail(client, auth, atsId);
          const job = this.assemble(preview, posting, atsId, clientkey, companyName);
          const post = this.toJobPost(job, input.descriptionFormat);
          if (post) jobPosts.push(post);
        } catch (err: any) {
          this.logger.warn(`Error processing Paycom job ${atsId}: ${err.message}`);
        }
      }

      this.logger.log(`Paycom total: ${jobPosts.length} jobs for ${clientkey}`);
      return new JobResponseDto(jobPosts);
    } catch (err: any) {
      this.logger.error(`Paycom scrape error for ${clientkey}: ${err.message}`);
      return new JobResponseDto(jobPosts, jobPosts.length ? undefined : classifyScrapeError(err)); // partial results
    }
  }

  /**
   * Fetch the clientkey-addressed board page as text. An unknown clientkey
   * (HTTP 4xx) or a missing page degrades to null (no throw).
   */
  private async fetchBoard(
    client: ReturnType<typeof createHttpClient>,
    url: string,
  ): Promise<string | null> {
    try {
      const response = await client.get<string>(url, { responseType: 'text' });
      return typeof response.data === 'string' ? response.data : null;
    } catch (err: any) {
      const status = err?.response?.status;
      if (status && status >= 400 && status < 500) {
        this.logger.warn(`Paycom board not found (HTTP ${status}) at ${url}`);
        return null;
      }
      throw err;
    }
  }

  /**
   * Read the public bearer (JWT) the React board boots into its
   * `configsFromHost.sessionJWT`. The token is public, page-embedded, and
   * read-only — no login is required. Returns null when absent.
   */
  private extractToken(html: string): string | null {
    const match = PAYCOM_SESSION_JWT_REGEX.exec(html);
    return match ? match[1] : null;
  }

  /** Resolve the tenant display name via the company-name endpoint. */
  private async fetchCompanyName(
    client: ReturnType<typeof createHttpClient>,
    auth: Record<string, string>,
  ): Promise<string | null> {
    try {
      const response = await client.get<PaycomCompanyNameResponse>(
        `${PAYCOM_API_ORIGIN}${PAYCOM_API_COMPANY_NAME_PATH}`,
        { headers: auth },
      );
      return this.cleanText(response.data?.companyName);
    } catch (err: any) {
      this.logger.warn(`Paycom company-name lookup failed: ${err.message}`);
      return null;
    }
  }

  /**
   * Enumerate a tenant's open-role previews via the search API. The endpoint is
   * paged by skip/take and requires the full `filtersForQuery` object (a bare
   * `{skip,take}` returns an empty set). An unknown clientkey / expired token
   * (HTTP 4xx) degrades to an empty list.
   */
  private async fetchPreviews(
    client: ReturnType<typeof createHttpClient>,
    auth: Record<string, string>,
    resultsWanted: number,
  ): Promise<PaycomJobPreview[]> {
    const take = Math.max(1, Math.min(resultsWanted, PAYCOM_DEFAULT_RESULTS));
    try {
      const response = await client.post<PaycomSearchResponse>(
        `${PAYCOM_API_ORIGIN}${PAYCOM_API_SEARCH_PATH}`,
        { skip: 0, take, filtersForQuery: PAYCOM_SEARCH_FILTERS },
        { headers: { ...auth, 'Content-Type': 'application/json' } },
      );
      const list = response.data?.jobPostingPreviews;
      return Array.isArray(list)
        ? list.filter((p): p is PaycomJobPreview => !!p && typeof p === 'object')
        : [];
    } catch (err: any) {
      const status = err?.response?.status;
      if (status && status >= 400 && status < 500) {
        this.logger.warn(`Paycom search returned HTTP ${status}`);
        return [];
      }
      throw err;
    }
  }

  /**
   * Fetch a single posting (wrapped in `jobPosting`). A removed role (HTTP 4xx)
   * degrades to null without failing the batch.
   */
  private async fetchDetail(
    client: ReturnType<typeof createHttpClient>,
    auth: Record<string, string>,
    atsId: string,
  ): Promise<PaycomJobPosting | null> {
    const url = `${PAYCOM_API_ORIGIN}${PAYCOM_API_DETAIL_PATH}/${encodeURIComponent(atsId)}`;
    try {
      const response = await client.get<PaycomDetailResponse>(url, { headers: auth });
      const posting = response.data?.jobPosting;
      return posting && typeof posting === 'object' ? posting : null;
    } catch (err: any) {
      const status = err?.response?.status;
      if (status && status >= 400 && status < 500) {
        this.logger.warn(`Paycom job ${atsId} not found (HTTP ${status})`);
        return null;
      }
      throw err;
    }
  }

  /** Assemble a normalised PaycomJob from the preview + detail payloads. */
  private assemble(
    preview: PaycomJobPreview,
    detail: PaycomJobPosting | null,
    atsId: string,
    clientkey: string,
    companyName: string | null,
  ): PaycomJob {
    const google = jobPostingLdFromNode(detail?.googleJobJson);
    const location =
      this.cleanText(detail?.location) ?? this.cleanText(preview.locations);

    return {
      jobId: atsId,
      url: this.cleanText(google?.url) ?? paycomJobUrl(clientkey, atsId),
      title: this.cleanText(detail?.jobTitle) ?? this.cleanText(preview.jobTitle),
      companyName,
      descriptionHtml: this.bodyHtml(detail, google),
      location,
      employmentType: this.cleanText(detail?.positionType ?? preview.positionType),
      department: this.cleanText(detail?.jobCategory),
      datePosted:
        this.parseDate(google?.datePosted) ?? this.parseDate(preview.postedOn),
      isRemote: this.detectRemote(preview, detail, location),
      remoteTypeCode: this.cleanText(detail?.remoteType ?? preview.remoteType),
      structuredCompensation: jobPostingLdToCompensation(google?.baseSalary),
    };
  }

  /**
   * The visible body spans both the `description` and `qualifications` HTML
   * sections; concatenate them. Fall back to the schema.org node's description.
   */
  private bodyHtml(
    detail: PaycomJobPosting | null,
    google: JobPostingLd | null,
  ): string | null {
    const body = [detail?.description, detail?.qualifications]
      .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
      .join('\n')
      .trim();
    if (body) return body;
    return this.cleanText(google?.description);
  }

  /** Map a normalised PaycomJob → JobPostDto. */
  private toJobPost(job: PaycomJob, format?: DescriptionFormat): JobPostDto | null {
    if (!job.title || !job.jobId || !job.url) return null;

    const description = this.formatDescription(job.descriptionHtml, format);

    const compensation = resolveCompensation({
      structured: job.structuredCompensation,
      text: description,
    });
    const salarySource = compensation
      ? job.structuredCompensation
        ? 'structured'
        : 'description'
      : null;

    const workFromHomeType = this.workFromHomeType(job);

    return new JobPostDto({
      id: `paycom-${job.jobId}`,
      title: job.title,
      companyName: job.companyName,
      jobUrl: job.url,
      location: this.buildLocation(job),
      description,
      datePosted: job.datePosted,
      isRemote: job.isRemote,
      ...(workFromHomeType ? { workFromHomeType } : {}),
      ...(compensation ? { compensation, salarySource } : {}),
      emails: extractEmails(description),
      site: Site.PAYCOM,
      atsId: job.jobId,
      atsType: 'paycom',
      department: job.department,
      employmentType: job.employmentType,
      applyUrl: job.url,
    });
  }

  /**
   * Convert the job-ad body per `descriptionFormat`. The detail body is HTML;
   * we prefer it so markdown / plain conversion is consistent.
   */
  private formatDescription(html: string | null, format?: DescriptionFormat): string | null {
    if (!html) return null;
    if (format === DescriptionFormat.HTML) return html;
    if (format === DescriptionFormat.MARKDOWN) return markdownConverter(html) ?? html;
    return htmlToPlainText(html);
  }

  /**
   * Resolve the tenant `clientkey`. A `companyUrl` on a Paycom board domain has
   * its clientkey extracted from the `/portal/{KEY}/` path or a `?clientkey=…`
   * query; an explicit `companySlug` is used verbatim when it looks like a bare
   * clientkey (or carries one). Returns an empty string when neither yields one.
   */
  private resolveClientKey(
    companySlug: string | undefined,
    companyUrl: string | undefined,
  ): string {
    if (companyUrl) {
      try {
        const u = new URL(companyUrl);
        const hostname = u.hostname.toLowerCase();
        const onBoard =
          hostname.endsWith(PAYCOM_ROOT_DOMAIN) ||
          PAYCOM_ALT_DOMAINS.some((d) => hostname === d || hostname.endsWith(`.${d}`));
        if (onBoard) {
          const fromKey = this.clientKeyFromUrl(companyUrl);
          if (fromKey) return fromKey;
        }
      } catch {
        // Malformed URL — fall through to the slug.
      }
      // Some callers pass an un-parseable/relative URL; still try to scrape a key.
      const fromKey = this.clientKeyFromUrl(companyUrl);
      if (fromKey) return fromKey;
    }
    if (companySlug && companySlug.trim()) {
      const slug = companySlug.trim();
      if (PAYCOM_CLIENTKEY_TOKEN_REGEX.test(slug)) return slug;
      const fromKey = this.clientKeyFromUrl(slug);
      if (fromKey) return fromKey;
    }
    return '';
  }

  /** Pull a clientkey from a board URL's `/portal/{KEY}/` path or `?clientkey=`. */
  private clientKeyFromUrl(value: string): string {
    const portal = PAYCOM_PORTAL_CLIENTKEY_REGEX.exec(value);
    if (portal && PAYCOM_CLIENTKEY_TOKEN_REGEX.test(portal[1])) return portal[1];
    const query = PAYCOM_QUERY_CLIENTKEY_REGEX.exec(value);
    if (query && PAYCOM_CLIENTKEY_TOKEN_REGEX.test(query[1])) return query[1];
    return '';
  }

  /** Resolve the stable per-role id from a preview. */
  private previewId(preview: PaycomJobPreview): string {
    const raw = preview.jobId;
    if (raw == null) return '';
    const s = String(raw).trim();
    return s.length > 0 ? s : '';
  }

  /** Parse the role's single location string into a LocationDto, or null. */
  private buildLocation(job: PaycomJob): LocationDto | null {
    if (!job.location) return job.isRemote ? new LocationDto({ city: 'Remote' }) : null;
    // Paycom appends a US ZIP ("Seymour, IN 47274"); strip it so the shared
    // "City, ST" parser can resolve a clean city/state.
    const text = job.location.replace(/\s+\d{5}(?:-\d{4})?$/, '').trim();
    return parseLocationText(text).location;
  }

  /**
   * Map the `remoteType` code (or remote text in the title / location) to a
   * work-from-home label, when the role is non-onsite.
   */
  private workFromHomeType(job: PaycomJob): string | null {
    const code = (job.remoteTypeCode ?? '').toUpperCase();
    if (code === 'H') return 'Hybrid';
    if (code === 'R' || code === 'T' || code === 'F') return 'Remote';
    return job.isRemote ? 'Remote' : null;
  }

  /** Detect remote roles from the `remoteType` code, the title, or the location. */
  private detectRemote(
    preview: PaycomJobPreview,
    detail: PaycomJobPosting | null,
    location: string | null,
  ): boolean {
    const code = this.cleanText(detail?.remoteType ?? preview.remoteType);
    if (code && PAYCOM_REMOTE_TYPE_CODES.has(code.toUpperCase())) return true;
    const haystacks = [this.cleanText(detail?.jobTitle ?? preview.jobTitle), location];
    return haystacks.some((field) => typeof field === 'string' && PAYCOM_REMOTE_REGEX.test(field));
  }

  /** Parse a date string into a YYYY-MM-DD string. */
  private parseDate(value: string | null | undefined): string | null {
    if (value == null || value === '') return null;
    const parsed = new Date(value);
    return isNaN(parsed.getTime()) ? null : toDateOnly(value);
  }

  /** Trim a string, returning null for empty / non-string values. */
  private cleanText(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null;
    const v = value.trim();
    return v.length > 0 ? v : null;
  }
}
