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
  ZIMYO_ROOT_DOMAIN,
  ZIMYO_API_BASE,
  ZIMYO_JOBLIST_PATH,
  ZIMYO_JOB_DETAIL_PATH,
  ZIMYO_ORG_DETAIL_PATH,
  ZIMYO_DEFAULT_RESULTS,
  ZIMYO_PAGE_SIZE,
  ZIMYO_MAX_PAGES,
  ZIMYO_DEFAULT_TIMEOUT_SECONDS,
  ZIMYO_HEADERS,
  ZIMYO_REMOTE_WORKPLACE_TYPE,
  ZIMYO_REMOTE_REGEX,
  zimyoDetailUrl,
} from './zimyo.constants';
import {
  ZimyoJob,
  ZimyoJobListItem,
  ZimyoJobListResponse,
  ZimyoJobDetail,
  ZimyoJobDetailResponse,
  ZimyoJobAllDetails,
  ZimyoOrgDetailResponse,
} from './zimyo.types';

/**
 * Zimyo ATS careers scraper — generic, multi-tenant.
 *
 * Zimyo (zimyo.com, India — a fast-growing HRMS + recruitment / ATS suite) powers a
 * public, unauthenticated candidate-facing career board for each customer tenant,
 * addressed by a numeric **organisation id** (the tenant key). The candidate-facing site
 * is a single-page (Vite/React) widget app at `https://zimyo.work/recruit`; it ships no
 * embedded role data and hydrates from a **public JSON widget API** on the ATS backend
 * host (`https://ats.zimyo.work/ats/ats`, no auth / no API key):
 *
 *   GET widget/joblist2?id={orgId}&per_page={n}&page={p}
 *     → { data: { result: [ { JOB_ID, JOB_TITLE, DEPARTMENT_NAME, LOCATION_NAME,
 *                             EMPLOYEMENT, CREATED_ON, … } ], totalCount, page } }
 *   GET widget/jobDetails?jobId={JOB_ID}
 *     → { data: { jobDetail: { JOB_DESCRIPTION (HTML), STREET_ADDRESS, ENTITY_NAME,
 *                              ALL_DETAILS: "{…WORKPLACE_TYPE…}", … } } }
 *   GET widget/orgDetails?org_id={orgId}
 *     → { data: [ { ORG_NAME, ORG_ADDRESS, ORG_LOGO } ] }   (tenant brand)
 *
 * The adapter pages the list, optionally enriches each role from the detail endpoint
 * (for the HTML body + workplace type), and maps each role — rather than depending on a
 * client-rendered DOM, a headless browser, or an authenticated REST API. Each role's
 * `JOB_ID` is the stable ATS id and builds the canonical public detail / apply URL
 * `/recruit/career/details/{base64(jobId)}/{base64(orgId)}`.
 *
 * The caller addresses a tenant by `companySlug` (the numeric org id, e.g. `1`) or by
 * `companyUrl` (a `zimyo.work` career URL whose path encodes the base64 org id, decoded
 * by the adapter). An unknown / disabled org, one with no open roles, or an empty board
 * degrades naturally to an empty result. A fetch error, an HTTP 4xx, a DNS failure, or a
 * malformed body degrades to an empty / partial result rather than throwing, so a single
 * tenant never nukes a batch run.
 */
@SourcePlugin({
  site: Site.ZIMYO,
  name: 'Zimyo',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class ZimyoService implements IScraper {
  private readonly logger = new Logger(ZimyoService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for Zimyo scraper');
      return new JobResponseDto([]);
    }

    const orgId = this.resolveOrg(companySlug, input.companyUrl);
    if (!orgId) {
      this.logger.warn('Could not resolve a Zimyo org id from input');
      return new JobResponseDto([]);
    }

    // Cap the per-request timeout so an unresponsive Zimyo widget host degrades
    // gracefully fast rather than hanging on the client's 60s default. Bound BOTH
    // keys: the no-proxy path keys off `timeout`, the proxy path off
    // `requestTimeout`. A caller may request a shorter timeout; we only cap.
    const timeoutSeconds = Math.min(
      input.requestTimeout ?? ZIMYO_DEFAULT_TIMEOUT_SECONDS,
      ZIMYO_DEFAULT_TIMEOUT_SECONDS,
    );
    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: timeoutSeconds,
      requestTimeout: timeoutSeconds,
    });
    client.setHeaders(ZIMYO_HEADERS);

    const resultsWanted = input.resultsWanted ?? ZIMYO_DEFAULT_RESULTS;
    const jobPosts: JobPostDto[] = [];

    try {
      this.logger.log(`Fetching Zimyo jobs for org: ${orgId}`);

      // The list records carry no brand name; fetch the tenant org's display brand once.
      const brandName = await this.fetchBrandName(client, orgId);

      const items = await this.fetchJobs(client, orgId, resultsWanted);
      if (items === null) {
        this.logger.log(`Zimyo org "${orgId}" has no reachable open-roles board`);
        return new JobResponseDto([]);
      }
      if (items.length === 0) {
        this.logger.log(`Zimyo org "${orgId}" has no open roles`);
        return new JobResponseDto([]);
      }

      const seen = new Set<string>();
      for (const item of items) {
        if (jobPosts.length >= resultsWanted) break;
        try {
          const post = await this.processItem(
            client,
            item,
            orgId,
            brandName,
            input.descriptionFormat,
            seen,
          );
          if (post) jobPosts.push(post);
        } catch (err: any) {
          this.logger.warn(`Error processing Zimyo role ${item?.JOB_ID}: ${err.message}`);
        }
      }

      this.logger.log(`Zimyo total: ${jobPosts.length} jobs for ${orgId}`);
      return new JobResponseDto(jobPosts);
    } catch (err: any) {
      this.logger.error(`Zimyo scrape error for ${orgId}: ${err.message}`);
      return new JobResponseDto(jobPosts); // partial results
    }
  }

  /**
   * Page through the public `widget/joblist2` endpoint, collecting roles up to
   * `resultsWanted` (bounded by the page cap). Returns:
   *  - an array of list roles (possibly empty — an empty board is a valid "no roles"
   *    result) when the host is reachable;
   *  - `null` ONLY when the tenant host itself is unreachable (transport-level failure),
   *    signalling the caller to degrade to an empty result.
   * Never throws — every failure degrades gracefully.
   */
  private async fetchJobs(
    client: ReturnType<typeof createHttpClient>,
    orgId: string,
    resultsWanted: number,
  ): Promise<ZimyoJobListItem[] | null> {
    const collected: ZimyoJobListItem[] = [];
    let page = 1;

    for (let fetched = 0; fetched < ZIMYO_MAX_PAGES; fetched++) {
      const { data, hostReachable } = await this.fetchJobListPage(client, orgId, page);
      // A transport-level failure (DNS / refused / reset / timeout) means the widget
      // host itself is unreachable — abort the whole sweep rather than burning a full
      // timeout per page.
      if (!hostReachable) return collected.length > 0 ? collected : null;
      if (data == null) break; // HTTP error / malformed body — stop, return what we have

      const result = Array.isArray(data.data?.result) ? data.data!.result! : [];
      for (const item of result) collected.push(item);

      // Stop once we have enough, the page came back short (last page), or the reported
      // totalCount is covered.
      const totalCount = this.toFiniteNumber(data.data?.totalCount);
      if (collected.length >= resultsWanted) break;
      if (result.length === 0 || result.length < ZIMYO_PAGE_SIZE) break;
      if (totalCount != null && collected.length >= totalCount) break;

      page++;
    }

    return collected;
  }

  /**
   * GET one page of the public `widget/joblist2` list. Returns `{ data, hostReachable }`:
   *  - `data` is the parsed list envelope, or null when the response carried no usable
   *    JSON / the host answered an HTTP error status (4xx / 5xx — a real, reachable host).
   *  - `hostReachable` is false ONLY for a transport-level failure (DNS / connection
   *    refused / reset / timeout). Never throws.
   */
  private async fetchJobListPage(
    client: ReturnType<typeof createHttpClient>,
    orgId: string,
    page: number,
  ): Promise<{ data: ZimyoJobListResponse | null; hostReachable: boolean }> {
    const url = `${ZIMYO_API_BASE}/${ZIMYO_JOBLIST_PATH}`;
    try {
      const response = await client.get<ZimyoJobListResponse>(url, {
        params: { id: orgId, per_page: ZIMYO_PAGE_SIZE, page },
      });
      const body = response.data;
      if (!body || typeof body !== 'object' || body.error === true) {
        return { data: null, hostReachable: true };
      }
      return { data: body, hostReachable: true };
    } catch (err: any) {
      const status = err?.response?.status;
      if (status) {
        // The host answered an HTTP status (4xx unknown-org / 5xx) — it is reachable.
        this.logger.warn(`Zimyo joblist returned HTTP ${status} for org ${orgId}`);
        return { data: null, hostReachable: true };
      }
      // No HTTP response → transport-level failure (DNS / refused / reset / timeout):
      // the widget host is unreachable. Degrade gracefully and signal host-down.
      this.logger.warn(`Zimyo joblist fetch failed for org ${orgId}: ${err?.message ?? err}`);
      return { data: null, hostReachable: false };
    }
  }

  /**
   * Fetch the rich per-role detail (`widget/jobDetails?jobId=`) for the HTML body +
   * structured workplace type. Returns null on any failure (the list fields still map);
   * never throws.
   */
  private async fetchJobDetail(
    client: ReturnType<typeof createHttpClient>,
    jobId: string,
  ): Promise<ZimyoJobDetail | null> {
    const url = `${ZIMYO_API_BASE}/${ZIMYO_JOB_DETAIL_PATH}`;
    try {
      const response = await client.get<ZimyoJobDetailResponse>(url, {
        params: { jobId },
      });
      const body = response.data;
      if (!body || body.error === true) return null;
      const detail = body.data?.jobDetail;
      return detail && typeof detail === 'object' ? detail : null;
    } catch (err: any) {
      this.logger.warn(`Zimyo jobDetails fetch failed for ${jobId}: ${err?.message ?? err}`);
      return null;
    }
  }

  /**
   * Fetch the tenant org's display brand name from `widget/orgDetails`. Returns an empty
   * string (falling back to the de-slugified org id later) on any failure; never throws.
   */
  private async fetchBrandName(
    client: ReturnType<typeof createHttpClient>,
    orgId: string,
  ): Promise<string> {
    const url = `${ZIMYO_API_BASE}/${ZIMYO_ORG_DETAIL_PATH}`;
    try {
      const response = await client.get<ZimyoOrgDetailResponse>(url, {
        params: { org_id: orgId },
      });
      const body = response.data;
      if (!body || body.error === true || !Array.isArray(body.data)) return '';
      const name = this.cleanText(body.data[0]?.ORG_NAME);
      return name ?? '';
    } catch (err: any) {
      this.logger.warn(`Zimyo orgDetails fetch failed for org ${orgId}: ${err?.message ?? err}`);
      return '';
    }
  }

  /** Map a parsed role → JobPostDto, enriching from the detail endpoint, deduping by ATS id. */
  private async processItem(
    client: ReturnType<typeof createHttpClient>,
    item: ZimyoJobListItem,
    orgId: string,
    brandName: string,
    format: DescriptionFormat | undefined,
    seen: Set<string>,
  ): Promise<JobPostDto | null> {
    const atsId = this.numToText(item.JOB_ID);
    if (!atsId) return null;
    if (seen.has(atsId)) return null;
    seen.add(atsId);

    // Enrich with the rich detail record (HTML body + structured workplace type). The
    // list fields remain the fallback when the detail call degrades.
    const detail = await this.fetchJobDetail(client, atsId);
    const job = this.normaliseItem(item, detail, orgId, brandName);
    if (!job) return null;
    return this.processJob(job, orgId, format);
  }

  /** Build a normalised ZimyoJob from a list role + its (optional) detail record. */
  private normaliseItem(
    item: ZimyoJobListItem,
    detail: ZimyoJobDetail | null,
    orgId: string,
    brandName: string,
  ): ZimyoJob | null {
    const atsId = this.numToText(item.JOB_ID ?? detail?.JOB_ID);
    if (!atsId) return null;

    const url = zimyoDetailUrl(orgId, atsId);
    const title = this.cleanText(item.JOB_TITLE) ?? this.cleanText(detail?.JOB_TITLE);
    const department =
      this.cleanText(item.DEPARTMENT_NAME) ?? this.cleanText(detail?.DEPARTMENT_NAME);
    const locationText = this.joinLocation(
      this.cleanText(item.LOCATION_NAME) ?? this.cleanText(detail?.LOCATION_NAME),
      this.cleanText(item.STREET_ADDRESS) ?? this.cleanText(detail?.STREET_ADDRESS),
    );
    const allDetails = this.parseAllDetails(detail?.ALL_DETAILS);
    const employmentType =
      this.cleanText(item.EMPLOYEMENT) ??
      this.cleanText(detail?.EMPLOYEMENT) ??
      this.cleanText(allDetails?.EMPLOYEMENT_TYPE);
    const workplaceType =
      this.cleanText(item.WORKPLACE_TYPE) ?? this.cleanText(allDetails?.WORKPLACE_TYPE);

    const brand =
      brandName ||
      this.cleanText(detail?.ENTITY_NAME) ||
      this.cleanText(item.ENTITY_NAME) ||
      this.deriveOrgName(orgId);

    return {
      atsId,
      url,
      // The Zimyo detail page hosts the apply flow inline; the canonical apply URL is the
      // detail URL itself.
      applyUrl: url,
      title,
      companyName: brand,
      locationText,
      descriptionHtml: this.cleanText(detail?.JOB_DESCRIPTION),
      department,
      employmentType,
      datePosted: this.parseDate(item.CREATED_ON ?? detail?.CREATED_ON),
      isRemote: this.detectRemote(workplaceType, title, locationText, department),
    };
  }

  /** Map a normalised ZimyoJob → JobPostDto. */
  private processJob(job: ZimyoJob, orgId: string, format?: DescriptionFormat): JobPostDto | null {
    const title = job.title;
    if (!title) return null;

    const atsId = job.atsId;
    if (!atsId) return null;

    const jobUrl = job.url;
    if (!jobUrl) return null;

    const companyName = job.companyName ?? this.deriveOrgName(orgId);
    const description = this.formatDescription(job.descriptionHtml ?? null, format);

    return new JobPostDto({
      id: `zimyo-${atsId}`,
      title,
      companyName,
      jobUrl,
      location: this.extractLocation(job),
      description,
      datePosted: job.datePosted ?? null,
      isRemote: job.isRemote ?? false,
      emails: extractEmails(description ?? ''),
      site: Site.ZIMYO,
      atsId,
      atsType: 'zimyo',
      department: job.department ?? null,
      employmentType: job.employmentType ?? null,
      applyUrl: job.applyUrl ?? jobUrl,
    });
  }

  /**
   * Convert the role description body per `descriptionFormat`. Zimyo exposes the body as
   * HTML when present, so HTML returns it as-is, Markdown converts it, and Plain strips
   * the tags.
   */
  private formatDescription(html: string | null, format?: DescriptionFormat): string | null {
    if (!html) return null;
    if (format === DescriptionFormat.HTML) return html;
    if (format === DescriptionFormat.MARKDOWN) return markdownConverter(html) ?? html;
    return htmlToPlainText(html) ?? html;
  }

  /**
   * Resolve the tenant org id. An explicit `companySlug` is used directly (a bare career
   * URL passed as the slug is reduced to its org token); a `companyUrl` on a `zimyo.work`
   * host has the org taken from the base64-encoded segment of its career path. Returns an
   * empty string when neither yields an org id.
   */
  private resolveOrg(companySlug: string | undefined, companyUrl: string | undefined): string {
    if (companySlug && companySlug.trim()) {
      const slug = companySlug.trim();
      // A caller may also pass a full career-site URL as the slug.
      if (/^https?:\/\//i.test(slug) || slug.includes(ZIMYO_ROOT_DOMAIN)) {
        const fromUrl = this.orgFromUrl(slug);
        if (fromUrl) return fromUrl;
      }
      // Otherwise the slug is the bare org id (numeric) — normalise it.
      return this.cleanOrgToken(slug);
    }
    if (companyUrl) {
      const fromUrl = this.orgFromUrl(companyUrl);
      if (fromUrl) return fromUrl;
    }
    return '';
  }

  /**
   * Derive the org id from a Zimyo career URL. The candidate-facing routes encode the org
   * id as the base64 final path segment:
   *   /recruit/career/details/{base64(jobId)}/{base64(orgId)}
   *   /recruit/career/joblist/{base64(orgId)}
   * The last path segment that base64-decodes to a numeric token is taken as the org id.
   */
  private orgFromUrl(value: string): string {
    const raw = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    try {
      const u = new URL(raw);
      const hostname = u.hostname.toLowerCase();
      if (!hostname.endsWith(ZIMYO_ROOT_DOMAIN)) {
        // Not a hosted Zimyo career host — no derivable org id.
        return '';
      }
      const segments = u.pathname.split('/').filter((s) => s.length > 0);
      // Walk segments right-to-left: the org id is the last base64-numeric token.
      for (let i = segments.length - 1; i >= 0; i--) {
        const decoded = this.tryDecodeOrg(segments[i]);
        if (decoded) return decoded;
      }
    } catch {
      // Malformed URL — no org id.
    }
    return '';
  }

  /** Decode a base64 path segment to a bare numeric org id, or '' if it is not one. */
  private tryDecodeOrg(segment: string): string {
    try {
      const decoded = Buffer.from(segment, 'base64').toString('utf8');
      const token = this.cleanOrgToken(decoded);
      return token;
    } catch {
      return '';
    }
  }

  /** Normalise an org token to a bare positive integer string, or '' when not numeric. */
  private cleanOrgToken(value: string): string {
    const v = (value ?? '').trim();
    return /^[0-9]+$/.test(v) ? v : '';
  }

  /** Parse the stringified `ALL_DETAILS` blob into its structured shape, defensively. */
  private parseAllDetails(value: string | null | undefined): ZimyoJobAllDetails | null {
    const cleaned = this.cleanText(value);
    if (!cleaned) return null;
    try {
      const parsed = JSON.parse(cleaned);
      return parsed && typeof parsed === 'object' ? (parsed as ZimyoJobAllDetails) : null;
    } catch {
      return null;
    }
  }

  /** De-slugify the org id into a display company name fallback. */
  private deriveOrgName(orgId: string): string {
    const base = orgId && orgId.trim() ? orgId.trim() : orgId;
    return `Zimyo Org ${base}`;
  }

  /**
   * Surface the role's free-text location as a LocationDto (city slot), leaving location
   * null when nothing usable is present.
   */
  private extractLocation(job: ZimyoJob): LocationDto | null {
    const text = job.locationText;
    if (!text) return null;
    return new LocationDto({ city: text });
  }

  /** Join the free-text location parts into a single line (deduping repeats). */
  private joinLocation(
    locationName: string | null,
    streetAddress: string | null,
  ): string | null {
    if (locationName) return locationName;
    if (streetAddress) return streetAddress;
    return null;
  }

  /**
   * Detect remote roles from the structured `WORKPLACE_TYPE` flag, then from the title,
   * location, or department text.
   */
  private detectRemote(
    workplaceType: string | null,
    title: string | null | undefined,
    location: string | null,
    department: string | null | undefined,
  ): boolean {
    if (workplaceType && workplaceType.toLowerCase() === ZIMYO_REMOTE_WORKPLACE_TYPE) {
      return true;
    }
    const haystacks: Array<string | null | undefined> = [title, location, department];
    for (const field of haystacks) {
      if (typeof field !== 'string') continue;
      if (ZIMYO_REMOTE_REGEX.test(field)) return true;
    }
    return false;
  }

  /**
   * Parse a `DD/MM/YYYY` (or ISO) date value into a YYYY-MM-DD string. Unparseable values
   * yield null.
   */
  private parseDate(value: string | null | undefined): string | null {
    const cleaned = this.cleanText(value);
    if (!cleaned) return null;
    // Zimyo emits `DD/MM/YYYY`; reorder to ISO before parsing.
    const dmy = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(cleaned);
    const iso = dmy ? `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}` : cleaned;
    try {
      const parsed = new Date(iso);
      if (!isNaN(parsed.getTime())) return toDateOnly(iso);
    } catch {
      // ignore
    }
    return null;
  }

  /** Coerce a numeric / string id field into trimmed text, or null when empty. */
  private numToText(value: number | string | null | undefined): string | null {
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    return this.cleanText(typeof value === 'string' ? value : null);
  }

  /** Coerce a value into a finite number, or null. */
  private toFiniteNumber(value: number | string | null | undefined): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() && !isNaN(Number(value))) return Number(value);
    return null;
  }

  /** Trim a string, returning null for empty / non-string values. */
  private cleanText(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null;
    const v = value.trim();
    return v.length > 0 ? v : null;
  }
}
