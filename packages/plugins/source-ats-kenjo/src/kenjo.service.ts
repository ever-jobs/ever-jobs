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
  KENJO_ROOT_DOMAIN,
  KENJO_CAREER_HOST_SUFFIX,
  KENJO_DEFAULT_RESULTS,
  KENJO_MAX_DETAIL_FETCHES,
  KENJO_DEFAULT_TIMEOUT_SECONDS,
  KENJO_HEADERS,
  KENJO_NON_TENANT_LABELS,
  KENJO_REMOTE_REGEX,
  kenjoCareerOrigin,
  kenjoPositionsUrl,
  kenjoPositionDetailUrl,
  kenjoDetailPageUrl,
} from './kenjo.constants';
import { KenjoCareerSiteResponse, KenjoJob, KenjoPosition } from './kenjo.types';

/**
 * Kenjo ATS careers scraper — generic, multi-tenant.
 *
 * Kenjo (kenjo.io, Berlin/Madrid — a DE/ES SMB HR & ATS suite) powers each customer's
 * branded, public, unauthenticated, candidate-facing career site on the shared host
 * `https://{tenant}.kenjo.io/` (an Angular SPA). Each tenant career site loads its data from
 * a **public, anonymous JSON API** served on the tenant's own career-site origin:
 *
 *   GET https://{tenant}.kenjo.io/api/controller/career-site/public/{tenant}/positions
 *     → career-site config envelope carrying `activePositions[]`
 *   GET https://{tenant}.kenjo.io/api/controller/career-site/public/{tenant}/positions/{customUrl}
 *     → a single role enriched with `jobDescription.html`
 *
 * Neither endpoint requires a bearer token, cookie, or API key — they are the exact feed the
 * public career site renders. The adapter GETs the list, reads `activePositions[]`, then
 * fetches a bounded number of per-role detail records (keyed by `customUrl`, not `_id`) to
 * enrich each role's description body — rather than depending on a headless browser to drive
 * the SPA, or the support-gated `api.kenjo.io` REST API.
 *
 * The caller addresses a tenant by `companySlug` (the career-site sub-domain label, e.g.
 * `careers`) or by `companyUrl` (a career-site URL whose host encodes the tenant slug). An
 * unknown tenant, a tenant with no career site (HTTP 404), an inactive board, or an empty
 * `activePositions[]` degrades naturally to an empty result. A fetch error, an HTTP 4xx, a
 * DNS failure, or a malformed body degrades to an empty / partial result rather than
 * throwing, so a single tenant never nukes a batch run.
 */
@SourcePlugin({
  site: Site.KENJO,
  name: 'Kenjo',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class KenjoService implements IScraper {
  private readonly logger = new Logger(KenjoService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for Kenjo scraper');
      return new JobResponseDto([]);
    }

    const tenant = this.resolveTenant(companySlug, input.companyUrl);
    if (!tenant) {
      this.logger.warn('Could not resolve a Kenjo tenant slug from input');
      return new JobResponseDto([]);
    }

    // Cap the per-request timeout so an unresponsive Kenjo career host degrades gracefully
    // fast rather than hanging on the client's 60s default. Bound BOTH keys: the no-proxy
    // path keys off `timeout`, the proxy path off `requestTimeout`. A caller may request a
    // shorter timeout; we only cap.
    const timeoutSeconds = Math.min(
      input.requestTimeout ?? KENJO_DEFAULT_TIMEOUT_SECONDS,
      KENJO_DEFAULT_TIMEOUT_SECONDS,
    );
    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: timeoutSeconds,
      requestTimeout: timeoutSeconds,
    });
    client.setHeaders(KENJO_HEADERS);

    const resultsWanted = input.resultsWanted ?? KENJO_DEFAULT_RESULTS;
    const jobPosts: JobPostDto[] = [];

    try {
      this.logger.log(`Fetching Kenjo jobs for tenant: ${tenant}`);

      const origin = kenjoCareerOrigin(tenant);
      const fallbackName = this.deriveSlugName(tenant);

      // The public list endpoint returns every active role in a single (un-paginated)
      // response. A transport-level failure / HTTP error degrades to an empty result.
      const listed = await this.fetchPositions(client, origin, tenant);
      if (!listed) {
        this.logger.log(`Kenjo total: 0 jobs for ${tenant}`);
        return new JobResponseDto([]);
      }

      const envelopeName = this.cleanText(listed.companyName) ?? fallbackName;
      const positions = Array.isArray(listed.activePositions) ? listed.activePositions : [];

      const seen = new Set<string>();
      let detailFetches = 0;

      for (const summary of positions) {
        if (jobPosts.length >= resultsWanted) break;

        try {
          const atsId = this.cleanText(summary?._id);
          if (!atsId || seen.has(atsId)) continue;
          seen.add(atsId);

          // Enrich the summary role with its detail body (jobDescription.html). The list is
          // authoritative for the role set; a failed / skipped detail fetch leaves the role
          // with no body rather than dropping it. Bound the detail fan-out.
          let detail: KenjoPosition | null = null;
          const customUrl = this.cleanText(summary?.customUrl);
          if (customUrl && detailFetches < KENJO_MAX_DETAIL_FETCHES) {
            detailFetches++;
            detail = await this.fetchPositionDetail(client, origin, tenant, customUrl);
          }

          const merged = this.mergePosition(summary, detail);
          const job = this.normalisePosition(merged, origin, envelopeName, fallbackName);
          if (!job) continue;

          const post = this.processJob(job, input.descriptionFormat);
          if (post) jobPosts.push(post);
        } catch (err: any) {
          this.logger.warn(`Error processing Kenjo role ${summary?._id}: ${err?.message ?? err}`);
        }
      }

      this.logger.log(`Kenjo total: ${jobPosts.length} jobs for ${tenant}`);
      return new JobResponseDto(jobPosts);
    } catch (err: any) {
      this.logger.error(`Kenjo scrape error for ${tenant}: ${err?.message ?? err}`);
      // Partial results WITH a reason: jobs.length > 0 plus a diagnostic is
      // inferred as 'partial' upstream, so a mid-scrape failure is no longer
      // indistinguishable from a complete board.
      return new JobResponseDto(jobPosts, classifyScrapeError(err));
    }
  }

  /**
   * GET the tenant's public career-site list endpoint as JSON. Returns the parsed
   * `{ …config…, activePositions }` envelope, or null when the response carried no usable
   * JSON, the career site does not exist (HTTP 404), or the host is unreachable. Never
   * throws — every failure degrades gracefully to null.
   */
  private async fetchPositions(
    client: ReturnType<typeof createHttpClient>,
    origin: string,
    tenant: string,
  ): Promise<KenjoCareerSiteResponse | null> {
    const url = kenjoPositionsUrl(origin, tenant);
    try {
      const response = await client.get<KenjoCareerSiteResponse | string>(url);
      return this.coerceEnvelope(response.data);
    } catch (err: any) {
      const status = err?.response?.status;
      if (status) {
        this.logger.warn(`Kenjo list endpoint returned HTTP ${status} for ${tenant}`);
      } else {
        this.logger.warn(`Kenjo list fetch failed for ${tenant}: ${err?.message ?? err}`);
      }
      return null;
    }
  }

  /**
   * GET a single role's public detail endpoint (keyed by `customUrl`) as JSON, used to
   * enrich the summary with its `jobDescription.html` body. Returns the parsed role, or null
   * on any failure — a missing detail body never drops the role.
   */
  private async fetchPositionDetail(
    client: ReturnType<typeof createHttpClient>,
    origin: string,
    tenant: string,
    customUrl: string,
  ): Promise<KenjoPosition | null> {
    const url = kenjoPositionDetailUrl(origin, tenant, customUrl);
    try {
      const response = await client.get<KenjoPosition | string>(url);
      const parsed = this.coercePosition(response.data);
      return parsed;
    } catch (err: any) {
      const status = err?.response?.status;
      this.logger.warn(
        `Kenjo detail fetch failed for ${tenant}/${customUrl}${status ? ` (HTTP ${status})` : ''}: ${err?.message ?? err}`,
      );
      return null;
    }
  }

  /**
   * Coerce an axios response body into a parsed career-site envelope. The client usually
   * parses the JSON for us (object body); a text/plain string body is parsed defensively. A
   * non-object / unparseable body yields null.
   */
  private coerceEnvelope(
    data: KenjoCareerSiteResponse | string | unknown,
  ): KenjoCareerSiteResponse | null {
    const obj = this.coerceObject(data);
    return obj ? (obj as KenjoCareerSiteResponse) : null;
  }

  /** Coerce an axios response body into a parsed role object. */
  private coercePosition(data: KenjoPosition | string | unknown): KenjoPosition | null {
    const obj = this.coerceObject(data);
    return obj ? (obj as KenjoPosition) : null;
  }

  /** Shared object-coercion: object as-is; string parsed as JSON; everything else null. */
  private coerceObject(data: unknown): Record<string, unknown> | null {
    if (data && typeof data === 'object') return data as Record<string, unknown>;
    if (typeof data === 'string') {
      const trimmed = data.trim();
      if (!trimmed) return null;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
      } catch (err: any) {
        this.logger.warn(`Kenjo JSON parse failed: ${err?.message ?? err}`);
      }
    }
    return null;
  }

  /**
   * Merge a summary role (authoritative for the role set) with its detail record
   * (authoritative for the description body), preferring detail values where present.
   */
  private mergePosition(summary: KenjoPosition, detail: KenjoPosition | null): KenjoPosition {
    if (!detail) return summary;
    return { ...summary, ...detail };
  }

  /** Build a normalised KenjoJob from a parsed role. */
  private normalisePosition(
    position: KenjoPosition,
    origin: string,
    envelopeName: string,
    fallbackName: string,
  ): KenjoJob | null {
    const atsId = this.cleanText(position._id);
    if (!atsId) return null;

    const customUrl = this.cleanText(position.customUrl);
    // The canonical public detail page is `{origin}/positions/{customUrl}`; fall back to a
    // derived `{origin}/positions/{id}` only if a role ever omits its customUrl.
    const url = customUrl
      ? kenjoDetailPageUrl(origin, customUrl)
      : kenjoDetailPageUrl(origin, atsId);

    const city = this.cleanText(position.city) ?? this.cleanText(position.officeName);
    const country = this.cleanText(position.country);
    const locationText = this.joinLocation(city, null, country);
    const title = this.cleanText(position.jobTitle);
    const department = this.cleanText(position.departmentName);
    const employmentType = this.cleanText(position.positionType);
    const descriptionHtml =
      this.cleanText(position.jobDescription?.html) ??
      this.cleanText(position.jobDescription?.text);

    return {
      atsId,
      url,
      // The Kenjo detail page hosts the apply flow inline; the canonical apply URL is the
      // detail URL itself.
      applyUrl: url,
      title,
      companyName: this.cleanText(position.companyName) ?? envelopeName ?? fallbackName,
      city,
      state: null,
      country,
      locationText,
      descriptionHtml,
      department,
      employmentType,
      datePosted: this.parseDate(position.publishedAt) ?? this.parseDate(position.createdAt),
      isRemote: this.detectRemote(title, locationText, employmentType, descriptionHtml),
    };
  }

  /** Map a normalised KenjoJob → JobPostDto. */
  private processJob(job: KenjoJob, format?: DescriptionFormat): JobPostDto | null {
    const title = job.title;
    if (!title) return null;

    const atsId = job.atsId;
    if (!atsId) return null;

    const jobUrl = job.url;
    if (!jobUrl) return null;

    const companyName = job.companyName ?? null;
    const description = this.formatDescription(job.descriptionHtml ?? null, format);

    return new JobPostDto({
      id: `kenjo-${atsId}`,
      title,
      companyName,
      jobUrl,
      location: this.extractLocation(job),
      description,
      datePosted: job.datePosted ?? null,
      isRemote: job.isRemote ?? false,
      emails: extractEmails(description ?? ''),
      site: Site.KENJO,
      atsId,
      atsType: 'kenjo',
      department: job.department ?? null,
      employmentType: job.employmentType ?? null,
      applyUrl: job.applyUrl ?? jobUrl,
    });
  }

  /**
   * Convert the role description body per `descriptionFormat`. Kenjo exposes the body as
   * HTML, so HTML returns it as-is, Markdown converts it, and Plain strips the tags.
   */
  private formatDescription(html: string | null, format?: DescriptionFormat): string | null {
    if (!html) return null;
    if (format === DescriptionFormat.HTML) return html;
    if (format === DescriptionFormat.MARKDOWN) return markdownConverter(html) ?? html;
    return htmlToPlainText(html) ?? html;
  }

  /**
   * Resolve the tenant slug. An explicit `companySlug` is used directly (a bare career-site
   * URL passed as the slug is reduced to its tenant token); a `companyUrl` on a `kenjo.io`
   * host has the tenant taken from its leading sub-domain label. Returns an empty string
   * when neither yields a tenant.
   */
  private resolveTenant(companySlug: string | undefined, companyUrl: string | undefined): string {
    if (companySlug && companySlug.trim()) {
      const slug = companySlug.trim();
      // A caller may also pass a full career-site URL as the slug.
      if (/^https?:\/\//i.test(slug) || slug.includes(KENJO_ROOT_DOMAIN)) {
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
   * Derive the tenant token from a Kenjo career-site URL. The candidate-facing host is
   * `{tenant}.kenjo.io`; the tenant is the leading sub-domain label.
   */
  private tenantFromUrl(value: string): string {
    const raw = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    try {
      const u = new URL(raw);
      const hostname = u.hostname.toLowerCase();
      if (!hostname.endsWith(KENJO_CAREER_HOST_SUFFIX)) {
        // Not a hosted career host — no derivable tenant.
        return '';
      }
      const label = hostname.slice(0, hostname.length - KENJO_CAREER_HOST_SUFFIX.length);
      // Guard against an empty / marketing / app / api label (non-tenant hosts).
      if (!label || KENJO_NON_TENANT_LABELS.has(label)) return '';
      return label.toLowerCase();
    } catch {
      // Malformed URL — no tenant.
    }
    return '';
  }

  /** De-slugify + title-case the tenant token into a display company name. */
  private deriveSlugName(tenant: string): string {
    const base = tenant && tenant.trim() ? tenant.trim() : tenant;
    return base.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /**
   * Surface the role's location parts as a LocationDto, leaving location null when nothing
   * usable is present.
   */
  private extractLocation(job: KenjoJob): LocationDto | null {
    const city = job.city;
    const state = job.state;
    const country = job.country;
    if (!city && !state && !country) return null;
    return new LocationDto({ city, state, country });
  }

  /** Join the structured location parts into a single free-text line (for remote tests). */
  private joinLocation(
    city: string | null,
    state: string | null,
    country: string | null,
  ): string | null {
    const parts = [city, state, country].filter((p): p is string => !!p);
    return parts.length > 0 ? parts.join(', ') : null;
  }

  /**
   * Detect remote roles from the title, location, employment-type, or description text —
   * Kenjo's public role records carry no structured remote flag.
   */
  private detectRemote(
    title: string | null,
    location: string | null,
    employmentType: string | null,
    descriptionHtml: string | null,
  ): boolean {
    const haystacks: Array<string | null | undefined> = [
      title,
      location,
      employmentType,
      descriptionHtml,
    ];
    for (const field of haystacks) {
      if (typeof field !== 'string') continue;
      if (KENJO_REMOTE_REGEX.test(field)) return true;
    }
    return false;
  }

  /**
   * Parse an ISO timestamp value into a YYYY-MM-DD string. Non-absolute / unparseable values
   * yield null.
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

  /** Trim a string, returning null for empty / non-string values. */
  private cleanText(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null;
    const v = value.trim();
    return v.length > 0 ? v : null;
  }
}
