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
  EDDY_ROOT_DOMAIN,
  EDDY_CAREERS_HOST,
  EDDY_CAREERS_PATH,
  EDDY_DEFAULT_RESULTS,
  EDDY_MAX_DETAIL_FETCHES,
  EDDY_DEFAULT_TIMEOUT_SECONDS,
  EDDY_HEADERS,
  EDDY_UUID_REGEX,
  EDDY_REMOTE_WORKPLACE_TYPE,
  EDDY_REMOTE_REGEX,
  eddyJobsListUrl,
  eddyJobDetailUrl,
  eddyJobPageUrl,
} from './eddy.constants';
import { EddyJob, EddyJobListItem, EddyJobDetail } from './eddy.types';

/**
 * Eddy ATS careers scraper — generic, multi-tenant.
 *
 * Eddy (eddy.com / eddyhr.com — a US small-business HR suite with an applicant-tracking
 * module) hosts every customer tenant's public, unauthenticated candidate-facing careers
 * board on the shared application host `https://app.eddy.com/careers/{organizationUuid}`.
 * The board is a single-page application — the roles are NOT in the landing HTML — backed
 * by a public, anonymous JSON API keyed by the tenant's organization UUID:
 *
 *   GET /api/ats/public/job-opening/organization/{organizationUuid}
 *       → array of open roles ({ jobOpeningUuid, title, departmentId, locationId, postedDate }).
 *   GET /api/ats/public/job-opening/{jobOpeningUuid}/organization/{organizationUuid}
 *       → per-role detail (description HTML, employmentType, workplaceType, …).
 *
 * The adapter calls the list endpoint, maps each role, and (best effort, bounded) fans out
 * to the per-role detail endpoint to enrich the description / employmentType / workplaceType
 * — rather than depending on a client-rendered DOM, a headless browser, or an authenticated
 * REST API. Each role's `jobOpeningUuid` builds the canonical detail / apply URL
 * `/careers/{org}/{jobUuid}` and is the stable ATS id.
 *
 * The caller addresses a tenant by `companySlug` (the organization UUID) or by `companyUrl`
 * (a careers URL on the `app.eddy.com` host whose first `/careers/{…}` path segment is the
 * organization UUID). An unknown tenant, one with no open roles, or an empty board degrades
 * naturally to an empty result. A fetch error, an HTTP 4xx, a DNS failure, or a malformed
 * body degrades to an empty / partial result rather than throwing, so a single tenant never
 * nukes a batch run.
 */
@SourcePlugin({
  site: Site.EDDY,
  name: 'Eddy',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class EddyService implements IScraper {
  private readonly logger = new Logger(EddyService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for Eddy scraper');
      return new JobResponseDto([]);
    }

    const tenant = this.resolveTenant(companySlug, input.companyUrl);
    if (!tenant) {
      // The public API strictly requires the organization UUID; a non-UUID vanity token
      // is unresolvable. Degrade to empty rather than firing a request we know 400s.
      this.logger.warn('Could not resolve an Eddy organization UUID from input');
      return new JobResponseDto([]);
    }

    // Cap the per-request timeout so an unresponsive Eddy careers host degrades gracefully
    // fast rather than hanging on the client's 60s default. Bound BOTH keys: the no-proxy
    // path keys off `timeout`, the proxy path off `requestTimeout`. A caller may request a
    // shorter timeout; we only cap.
    const timeoutSeconds = Math.min(
      input.requestTimeout ?? EDDY_DEFAULT_TIMEOUT_SECONDS,
      EDDY_DEFAULT_TIMEOUT_SECONDS,
    );
    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: timeoutSeconds,
      requestTimeout: timeoutSeconds,
    });
    client.setHeaders(EDDY_HEADERS);

    const resultsWanted = input.resultsWanted ?? EDDY_DEFAULT_RESULTS;
    const jobPosts: JobPostDto[] = [];

    try {
      this.logger.log(`Fetching Eddy jobs for organization: ${tenant}`);

      const list = await this.fetchJobsList(client, tenant);
      if (list == null) {
        this.logger.log(`Eddy organization "${tenant}" has no reachable open-roles board`);
        return new JobResponseDto([]);
      }
      if (list.length === 0) {
        this.logger.log(`Eddy organization "${tenant}" has no open roles`);
        return new JobResponseDto([]);
      }

      // Select the roles to ingest (deduped by ATS id, bounded by resultsWanted) BEFORE
      // the detail fan-out, so we never fetch a detail we would discard.
      const selected = this.selectItems(list, resultsWanted);

      // Best-effort, bounded per-role detail enrichment. Each detail call is independent;
      // a single failure must not nuke the batch, so fan out with Promise.allSettled.
      const details = await this.fetchDetails(client, tenant, selected);

      const companyName = this.deriveSlugName(tenant);
      for (let i = 0; i < selected.length; i++) {
        try {
          const post = this.processItem(
            selected[i],
            details[i] ?? null,
            tenant,
            companyName,
            input.descriptionFormat,
          );
          if (post) jobPosts.push(post);
        } catch (err: any) {
          this.logger.warn(
            `Error processing Eddy role ${selected[i]?.jobOpeningUuid}: ${err.message}`,
          );
        }
      }

      this.logger.log(`Eddy total: ${jobPosts.length} jobs for ${tenant}`);
      return new JobResponseDto(jobPosts);
    } catch (err: any) {
      this.logger.error(`Eddy scrape error for ${tenant}: ${err.message}`);
      // Partial results WITH a reason: jobs.length > 0 plus a diagnostic is
      // inferred as 'partial' upstream, so a mid-scrape failure is no longer
      // indistinguishable from a complete board.
      return new JobResponseDto(jobPosts, classifyScrapeError(err));
    }
  }

  /**
   * Fetch the tenant's public open-roles list from
   * `/api/ats/public/job-opening/organization/{organizationUuid}`. Returns:
   *  - the (possibly empty) array of list records when the endpoint answers with JSON (an
   *    empty board is a valid "no roles" result), or
   *  - `null` when the host is unreachable / answers an HTTP error / returns a non-array
   *    body. Never throws.
   */
  private async fetchJobsList(
    client: ReturnType<typeof createHttpClient>,
    organizationUuid: string,
  ): Promise<EddyJobListItem[] | null> {
    const url = eddyJobsListUrl(organizationUuid);
    try {
      const response = await client.get<unknown>(url, { responseType: 'json' });
      const data = response?.data;
      if (Array.isArray(data)) return data as EddyJobListItem[];
      // Some hosts double-encode the JSON body as a string — parse defensively.
      if (typeof data === 'string') {
        try {
          const parsed = JSON.parse(data);
          if (Array.isArray(parsed)) return parsed as EddyJobListItem[];
        } catch {
          // fall through to null
        }
      }
      return null;
    } catch (err: any) {
      const status = err?.response?.status;
      if (status) {
        // The host answered an HTTP status (4xx unknown / disabled tenant, 5xx) — it is
        // reachable but has no usable board for us. Degrade to empty, never throw.
        this.logger.warn(`Eddy list returned HTTP ${status} for ${organizationUuid}`);
        return null;
      }
      // No HTTP response → transport-level failure (DNS / refused / reset / timeout).
      this.logger.warn(
        `Eddy list fetch failed for ${organizationUuid}: ${err?.message ?? err}`,
      );
      return null;
    }
  }

  /**
   * Best-effort, bounded per-role detail enrichment. Fans out one detail GET per selected
   * role (capped at `EDDY_MAX_DETAIL_FETCHES`) and returns an array aligned 1:1 with
   * `items` — `null` for any role whose detail was not fetched or failed. Uses
   * `Promise.allSettled` so a single failing detail never nukes the batch.
   */
  private async fetchDetails(
    client: ReturnType<typeof createHttpClient>,
    organizationUuid: string,
    items: EddyJobListItem[],
  ): Promise<Array<EddyJobDetail | null>> {
    const results = await Promise.allSettled(
      items.map((item, idx) => {
        const atsId = this.cleanText(item.jobOpeningUuid);
        if (!atsId || idx >= EDDY_MAX_DETAIL_FETCHES) {
          return Promise.resolve<EddyJobDetail | null>(null);
        }
        return this.fetchDetail(client, organizationUuid, atsId);
      }),
    );
    return results.map((r) => (r.status === 'fulfilled' ? r.value : null));
  }

  /**
   * GET a single role's public detail from
   * `/api/ats/public/job-opening/{jobOpeningUuid}/organization/{organizationUuid}`.
   * Returns the parsed detail, or `null` on any error / non-object body. Never throws —
   * the role still maps from its list record, just without the enriched body.
   */
  private async fetchDetail(
    client: ReturnType<typeof createHttpClient>,
    organizationUuid: string,
    jobOpeningUuid: string,
  ): Promise<EddyJobDetail | null> {
    const url = eddyJobDetailUrl(jobOpeningUuid, organizationUuid);
    try {
      const response = await client.get<unknown>(url, { responseType: 'json' });
      const data = response?.data;
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        return data as EddyJobDetail;
      }
      if (typeof data === 'string') {
        try {
          const parsed = JSON.parse(data);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return parsed as EddyJobDetail;
          }
        } catch {
          // ignore
        }
      }
      return null;
    } catch (err: any) {
      this.logger.warn(
        `Eddy detail fetch failed for ${jobOpeningUuid}: ${err?.message ?? err}`,
      );
      return null;
    }
  }

  /**
   * Select the list records to ingest: dedupe by ATS id (the `jobOpeningUuid`) and bound
   * to `resultsWanted`. Records without a usable id are skipped here so the detail fan-out
   * never wastes a request.
   */
  private selectItems(items: EddyJobListItem[], resultsWanted: number): EddyJobListItem[] {
    const seen = new Set<string>();
    const selected: EddyJobListItem[] = [];
    for (const item of items) {
      if (selected.length >= resultsWanted) break;
      const atsId = this.cleanText(item.jobOpeningUuid);
      if (!atsId) continue;
      if (seen.has(atsId)) continue;
      seen.add(atsId);
      selected.push(item);
    }
    return selected;
  }

  /** Map a list record (+ optional detail) → JobPostDto. */
  private processItem(
    item: EddyJobListItem,
    detail: EddyJobDetail | null,
    organizationUuid: string,
    companyName: string,
    format: DescriptionFormat | undefined,
  ): JobPostDto | null {
    const job = this.normaliseItem(item, detail, organizationUuid, companyName);
    if (!job) return null;
    return this.processJob(job, organizationUuid, format);
  }

  /** Build a normalised EddyJob from a list record and its (optional) detail record. */
  private normaliseItem(
    item: EddyJobListItem,
    detail: EddyJobDetail | null,
    organizationUuid: string,
    companyName: string,
  ): EddyJob | null {
    const atsId = this.cleanText(item.jobOpeningUuid);
    if (!atsId) return null;

    const url = eddyJobPageUrl(organizationUuid, atsId);
    const title = this.cleanText(item.title) ?? this.cleanText(detail?.title);
    const descriptionHtml = this.cleanText(detail?.description);
    const employmentType = this.cleanText(detail?.employmentType);
    const datePosted = this.parseDate(item.postedDate ?? detail?.postedDate);

    return {
      atsId,
      url,
      // The Eddy detail page hosts the apply flow inline; the canonical apply URL is the
      // detail URL itself.
      applyUrl: url,
      title,
      companyName,
      descriptionHtml,
      employmentType,
      datePosted,
      isRemote: this.detectRemote(detail, title, descriptionHtml),
    };
  }

  /** Map a normalised EddyJob → JobPostDto. */
  private processJob(
    job: EddyJob,
    organizationUuid: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const title = job.title;
    if (!title) return null;

    const atsId = job.atsId;
    if (!atsId) return null;

    const jobUrl = job.url;
    if (!jobUrl) return null;

    const companyName = job.companyName ?? this.deriveSlugName(organizationUuid);
    const description = this.formatDescription(job.descriptionHtml ?? null, format);

    return new JobPostDto({
      id: `eddy-${atsId}`,
      title,
      companyName,
      jobUrl,
      // The public anonymous role records expose location only as an opaque `locationId`
      // (resolvable to a city/state name solely via an authenticated HR endpoint), so no
      // structured location is surfaced here.
      location: this.extractLocation(),
      description,
      datePosted: job.datePosted ?? null,
      isRemote: job.isRemote ?? false,
      emails: extractEmails(description ?? ''),
      site: Site.EDDY,
      atsId,
      atsType: 'eddy',
      department: null,
      employmentType: this.normaliseEmploymentType(job.employmentType),
      applyUrl: job.applyUrl ?? jobUrl,
    });
  }

  /**
   * Convert the role description body per `descriptionFormat`. Eddy detail bodies are
   * HTML, so HTML returns it as-is, Markdown converts it, and Plain strips the tags.
   */
  private formatDescription(html: string | null, format?: DescriptionFormat): string | null {
    if (!html) return null;
    if (format === DescriptionFormat.HTML) return html;
    if (format === DescriptionFormat.MARKDOWN) return markdownConverter(html) ?? html;
    return htmlToPlainText(html) ?? html;
  }

  /**
   * Resolve the tenant's organization UUID. An explicit `companySlug` is used directly
   * when it is a UUID (a full careers URL passed as the slug is reduced to its UUID
   * segment); a `companyUrl` on the `app.eddy.com` host has the UUID taken from its first
   * `/careers/{…}` path segment. Returns an empty string when neither yields a UUID — the
   * public API strictly requires the organization UUID.
   */
  private resolveTenant(
    companySlug: string | undefined,
    companyUrl: string | undefined,
  ): string {
    if (companySlug && companySlug.trim()) {
      const slug = companySlug.trim();
      // A caller may also pass a full careers URL as the slug.
      if (/^https?:\/\//i.test(slug) || slug.includes(EDDY_ROOT_DOMAIN)) {
        const fromUrl = this.tenantFromUrl(slug);
        if (fromUrl) return fromUrl;
      }
      // Accept a bare organization UUID directly.
      if (EDDY_UUID_REGEX.test(slug)) return slug.toLowerCase();
      return '';
    }
    if (companyUrl) {
      const fromUrl = this.tenantFromUrl(companyUrl);
      if (fromUrl) return fromUrl;
    }
    return '';
  }

  /**
   * Derive the organization UUID from an Eddy careers URL. The candidate-facing board is
   * `https://app.eddy.com/careers/{organizationUuid}[/{jobUuid}]`; the UUID is the path
   * segment immediately after `careers`. A leading vanity segment (a non-UUID tenant
   * handle) is skipped — the UUID is taken from the first UUID-shaped path segment.
   */
  private tenantFromUrl(value: string): string {
    const raw = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    try {
      const u = new URL(raw);
      const hostname = u.hostname.toLowerCase();
      if (hostname !== EDDY_CAREERS_HOST && !hostname.endsWith(`.${EDDY_ROOT_DOMAIN}`)) {
        // Not an Eddy careers host — no derivable tenant.
        return '';
      }
      const segments = u.pathname.split('/').filter((s) => s.length > 0);
      const careersIdx = segments.findIndex((s) => s.toLowerCase() === EDDY_CAREERS_PATH);
      // Search the segments after `careers` (the canonical org UUID is the next segment;
      // tolerate a leading vanity segment by taking the first UUID-shaped token).
      const tail = careersIdx >= 0 ? segments.slice(careersIdx + 1) : segments;
      for (const seg of tail) {
        const token = decodeURIComponent(seg);
        if (EDDY_UUID_REGEX.test(token)) return token.toLowerCase();
      }
    } catch {
      // Malformed URL — no tenant.
    }
    return '';
  }

  /** De-slugify the organization token into a best-effort display company name. */
  private deriveSlugName(organizationUuid: string): string {
    const base = organizationUuid && organizationUuid.trim() ? organizationUuid.trim() : organizationUuid;
    // The tenant token is an opaque UUID with no embedded brand; surface it as-is rather
    // than inventing a name (the per-role records carry no company brand name).
    return base;
  }

  /**
   * The public anonymous role records expose location only as an opaque `locationId`
   * (resolvable solely via an authenticated HR endpoint), so no structured location is
   * available on the anonymous surface; location is left null.
   */
  private extractLocation(): LocationDto | null {
    return null;
  }

  /**
   * Detect remote roles from the structured `workplaceType` flag, then from the title or
   * description text.
   */
  private detectRemote(
    detail: EddyJobDetail | null,
    title: string | null | undefined,
    descriptionHtml: string | null | undefined,
  ): boolean {
    const workplaceType = this.cleanText(detail?.workplaceType);
    if (workplaceType && workplaceType.toUpperCase() === EDDY_REMOTE_WORKPLACE_TYPE) {
      return true;
    }
    const haystacks: Array<string | null | undefined> = [title, descriptionHtml];
    for (const field of haystacks) {
      if (typeof field !== 'string') continue;
      if (EDDY_REMOTE_REGEX.test(field)) return true;
    }
    return false;
  }

  /**
   * Normalise Eddy's `employmentType` token (e.g. `FULL_TIME`) into a human-readable
   * label (`Full Time`), or null when absent.
   */
  private normaliseEmploymentType(value: string | null | undefined): string | null {
    const cleaned = this.cleanText(value);
    if (!cleaned) return null;
    return cleaned
      .replace(/[_-]+/g, ' ')
      .toLowerCase()
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /**
   * Parse an ISO timestamp value into a YYYY-MM-DD string. Non-absolute / unparseable
   * values yield null.
   */
  private parseDate(value: string | null | undefined): string | null {
    const cleaned = this.cleanText(value);
    if (!cleaned) return null;
    try {
      const parsed = new Date(cleaned);
      if (!isNaN(parsed.getTime())) return toDateOnly(cleaned);
    } catch {
      // ignore
    }
    return null;
  }

  /** Trim a string (or stringify a number), returning null for empty / non-usable values. */
  private cleanText(value: string | number | null | undefined): string | null {
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    if (typeof value !== 'string') return null;
    const v = value.trim();
    return v.length > 0 ? v : null;
  }
}
