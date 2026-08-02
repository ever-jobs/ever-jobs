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
  HIREHIVE_ROOT_DOMAIN,
  HIREHIVE_CAREER_HOST_SUFFIX,
  HIREHIVE_JOBS_PATH,
  HIREHIVE_SOURCE,
  HIREHIVE_PAGE_SIZE,
  HIREHIVE_DEFAULT_RESULTS,
  HIREHIVE_MAX_PAGES,
  HIREHIVE_DEFAULT_TIMEOUT_SECONDS,
  HIREHIVE_HEADERS,
  HIREHIVE_REMOTE_TYPE,
  HIREHIVE_REMOTE_REGEX,
  hirehiveCareerOrigin,
} from './hirehive.constants';
import { HirehiveJob, HirehiveJobItem, HirehiveJobsResponse } from './hirehive.types';

/**
 * Hirehive ATS careers scraper — generic, multi-tenant.
 *
 * Hirehive (hirehive.com, Cork, Ireland — an EU/Irish SMB applicant-tracking system used
 * by hundreds of companies) powers each customer's branded, public, unauthenticated
 * candidate-facing career site on the shared host `https://{tenant}.hirehive.com/`. Each
 * tenant career site is backed by a **public, anonymous JSON feed** on the same host:
 *
 *   GET https://{tenant}.hirehive.com/api/v2/jobs?page={n}&page_size={k}&source=CareerSite
 *
 * which returns a JSON:API-style envelope `{ meta, links, items }` whose `items[]` array
 * holds the tenant's open roles (the endpoint advertises `security: []` — no bearer token).
 * The adapter GETs this feed, drains pages via `meta.has_next_page`, and maps each role —
 * rather than depending on a client-rendered DOM, a headless browser, or the authenticated
 * `api.hirehive.com` REST API (which DOES require a bearer token). Each role's string `id`
 * (e.g. `job_QxZUlo`) is the stable ATS id, and its `hosted_url` is the canonical public
 * detail / apply page.
 *
 * The caller addresses a tenant by `companySlug` (e.g. `hirehive`) or by `companyUrl` (a
 * career-site URL whose host encodes the tenant slug). An unknown tenant, one with no open
 * roles, or an empty board degrades naturally to an empty result. A fetch error, an HTTP
 * 4xx, a DNS failure, or a malformed body degrades to an empty / partial result rather than
 * throwing, so a single tenant never nukes a batch run.
 */
@SourcePlugin({
  site: Site.HIREHIVE,
  name: 'Hirehive',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class HirehiveService implements IScraper {
  private readonly logger = new Logger(HirehiveService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for Hirehive scraper');
      return new JobResponseDto([]);
    }

    const tenant = this.resolveTenant(companySlug, input.companyUrl);
    if (!tenant) {
      this.logger.warn('Could not resolve a Hirehive tenant slug from input');
      return new JobResponseDto([]);
    }

    // Cap the per-request timeout so an unresponsive Hirehive career host degrades
    // gracefully fast rather than hanging on the client's 60s default. Bound BOTH
    // keys: the no-proxy path keys off `timeout`, the proxy path off
    // `requestTimeout`. A caller may request a shorter timeout; we only cap.
    const timeoutSeconds = Math.min(
      input.requestTimeout ?? HIREHIVE_DEFAULT_TIMEOUT_SECONDS,
      HIREHIVE_DEFAULT_TIMEOUT_SECONDS,
    );
    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: timeoutSeconds,
      requestTimeout: timeoutSeconds,
    });
    client.setHeaders(HIREHIVE_HEADERS);

    const resultsWanted = input.resultsWanted ?? HIREHIVE_DEFAULT_RESULTS;
    const jobPosts: JobPostDto[] = [];

    try {
      this.logger.log(`Fetching Hirehive jobs for tenant: ${tenant}`);

      const companyName = this.deriveSlugName(tenant);
      const seen = new Set<string>();

      // Drain the paginated public feed up to the page cap or until we've collected
      // `resultsWanted` roles. A transport-level failure (host unreachable) aborts the
      // sweep; an HTTP error / malformed page degrades to an empty / partial result.
      for (let page = 1; page <= HIREHIVE_MAX_PAGES; page++) {
        if (jobPosts.length >= resultsWanted) break;

        const result = await this.fetchPage(client, tenant, page);
        // hostReachable === false → DNS / refused / reset / timeout: no further page can
        // succeed, so stop probing rather than burning a timeout per page.
        if (!result.hostReachable) break;
        const body = result.data;
        if (!body) break; // HTTP error / unparseable body → stop draining

        const items = Array.isArray(body.items) ? body.items : [];
        for (const item of items) {
          if (jobPosts.length >= resultsWanted) break;
          try {
            const post = this.processItem(item, tenant, companyName, input.descriptionFormat, seen);
            if (post) jobPosts.push(post);
          } catch (err: any) {
            this.logger.warn(`Error processing Hirehive role ${item?.id}: ${err.message}`);
          }
        }

        // Stop when the feed reports no further page (or omits the flag — single page).
        if (!body.meta?.has_next_page) break;
      }

      this.logger.log(`Hirehive total: ${jobPosts.length} jobs for ${tenant}`);
      return new JobResponseDto(jobPosts);
    } catch (err: any) {
      this.logger.error(`Hirehive scrape error for ${tenant}: ${err.message}`);
      return new JobResponseDto(jobPosts); // partial results
    }
  }

  /**
   * GET one page of the tenant's public jobs feed as JSON. Returns
   * `{ data, hostReachable }`:
   *  - `data` is the parsed `{ meta, links, items }` envelope, or null when the response
   *    carried no usable JSON / the host answered an HTTP error status (4xx / 5xx — a real,
   *    reachable host).
   *  - `hostReachable` is false ONLY for a transport-level failure (DNS / connection
   *    refused / reset / timeout), where the tenant host itself is unreachable and the
   *    caller should stop draining further pages.
   * Never throws — every failure degrades gracefully.
   */
  private async fetchPage(
    client: ReturnType<typeof createHttpClient>,
    tenant: string,
    page: number,
  ): Promise<{ data: HirehiveJobsResponse | null; hostReachable: boolean }> {
    const url = this.buildFeedUrl(tenant, page);
    try {
      const response = await client.get<HirehiveJobsResponse | string>(url);
      const parsed = this.coerceBody(response.data);
      return { data: parsed, hostReachable: true };
    } catch (err: any) {
      const status = err?.response?.status;
      if (status) {
        // The host answered an HTTP status (4xx unknown-tenant / 5xx) — it is reachable,
        // but there is nothing more to drain.
        this.logger.warn(`Hirehive feed returned HTTP ${status} for ${tenant}`);
        return { data: null, hostReachable: true };
      }
      // No HTTP response → transport-level failure (DNS / refused / reset / timeout): the
      // tenant host is unreachable. Degrade gracefully and signal host-down.
      this.logger.warn(`Hirehive feed fetch failed for ${tenant}: ${err?.message ?? err}`);
      return { data: null, hostReachable: false };
    }
  }

  /**
   * Coerce an axios response body into a parsed feed envelope. The client usually parses
   * the JSON for us (object body); if a tenant serves the feed as a text/plain string we
   * parse it ourselves. A non-object / unparseable body yields null (degrade to no roles).
   */
  private coerceBody(data: HirehiveJobsResponse | string | unknown): HirehiveJobsResponse | null {
    if (data && typeof data === 'object') return data as HirehiveJobsResponse;
    if (typeof data === 'string') {
      const trimmed = data.trim();
      if (!trimmed) return null;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object') return parsed as HirehiveJobsResponse;
      } catch (err: any) {
        this.logger.warn(`Hirehive feed JSON parse failed: ${err?.message ?? err}`);
      }
    }
    return null;
  }

  /** Map a parsed role → JobPostDto, deduping by ATS id. */
  private processItem(
    item: HirehiveJobItem,
    tenant: string,
    companyName: string,
    format: DescriptionFormat | undefined,
    seen: Set<string>,
  ): JobPostDto | null {
    const job = this.normaliseItem(item, tenant, companyName);
    if (!job) return null;
    if (seen.has(job.atsId)) return null;
    seen.add(job.atsId);
    return this.processJob(job, tenant, format);
  }

  /** Build a normalised HirehiveJob from a parsed role. */
  private normaliseItem(
    item: HirehiveJobItem,
    tenant: string,
    companyName: string,
  ): HirehiveJob | null {
    const atsId = this.cleanText(item.id);
    if (!atsId) return null;

    // The feed always carries the canonical detail URL in `hosted_url`; fall back to a
    // derived origin/id only if a future shape ever omits it.
    const url = this.cleanText(item.hosted_url) ?? this.buildJobUrl(tenant, atsId);
    const city = this.cleanText(item.location);
    const state = this.cleanText(item.state_code);
    const country = this.cleanText(item.country?.name) ?? this.cleanText(item.country?.code);
    const locationText = this.joinLocation(city, state, country);
    const department = this.cleanText(item.category?.name);
    const title = this.cleanText(item.title);
    const employmentType = this.cleanText(item.type?.name);

    return {
      atsId,
      url,
      // The Hirehive detail page hosts the apply flow inline; the canonical apply URL is
      // the detail URL itself.
      applyUrl: url,
      title,
      companyName: companyName || this.deriveSlugName(tenant),
      city,
      state,
      country,
      locationText,
      descriptionHtml: this.cleanText(item.description?.html) ?? this.cleanText(item.description?.text),
      department,
      employmentType,
      datePosted: this.parseDate(item.published_date),
      isRemote: this.detectRemote(item, title, locationText, department),
    };
  }

  /** Map a normalised HirehiveJob → JobPostDto. */
  private processJob(
    job: HirehiveJob,
    tenant: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const title = job.title;
    if (!title) return null;

    const atsId = job.atsId;
    if (!atsId) return null;

    const jobUrl = job.url;
    if (!jobUrl) return null;

    const companyName = job.companyName ?? this.deriveSlugName(tenant);
    const description = this.formatDescription(job.descriptionHtml ?? null, format);

    return new JobPostDto({
      id: `hirehive-${atsId}`,
      title,
      companyName,
      jobUrl,
      location: this.extractLocation(job),
      description,
      datePosted: job.datePosted ?? null,
      isRemote: job.isRemote ?? false,
      emails: extractEmails(description ?? ''),
      site: Site.HIREHIVE,
      atsId,
      atsType: 'hirehive',
      department: job.department ?? null,
      employmentType: job.employmentType ?? null,
      applyUrl: job.applyUrl ?? jobUrl,
    });
  }

  /**
   * Convert the role description body per `descriptionFormat`. Hirehive exposes the body
   * as HTML, so HTML returns it as-is, Markdown converts it, and Plain strips the tags.
   */
  private formatDescription(html: string | null, format?: DescriptionFormat): string | null {
    if (!html) return null;
    if (format === DescriptionFormat.HTML) return html;
    if (format === DescriptionFormat.MARKDOWN) return markdownConverter(html) ?? html;
    return htmlToPlainText(html) ?? html;
  }

  /**
   * Resolve the tenant slug. An explicit `companySlug` is used directly (a bare
   * career-site URL passed as the slug is reduced to its tenant token); a `companyUrl`
   * on a `hirehive.com` host has the tenant taken from its leading sub-domain label.
   * Returns an empty string when neither yields a tenant.
   */
  private resolveTenant(companySlug: string | undefined, companyUrl: string | undefined): string {
    if (companySlug && companySlug.trim()) {
      const slug = companySlug.trim();
      // A caller may also pass a full career-site URL as the slug.
      if (/^https?:\/\//i.test(slug) || slug.includes(HIREHIVE_ROOT_DOMAIN)) {
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
   * Derive the tenant token from a Hirehive career-site URL. The candidate-facing host is
   * `{tenant}.hirehive.com`; the tenant is the leading sub-domain label.
   */
  private tenantFromUrl(value: string): string {
    const raw = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    try {
      const u = new URL(raw);
      const hostname = u.hostname.toLowerCase();
      if (!hostname.endsWith(HIREHIVE_CAREER_HOST_SUFFIX)) {
        // Not a hosted career host — no derivable tenant.
        return '';
      }
      const label = hostname.slice(0, hostname.length - HIREHIVE_CAREER_HOST_SUFFIX.length);
      // Guard against an empty / `www` / `app` / `api` label (non-tenant hosts).
      if (!label || label === 'www' || label === 'app' || label === 'api') return '';
      return label.toLowerCase();
    } catch {
      // Malformed URL — no tenant.
    }
    return '';
  }

  /** Assemble a tenant's public jobs-feed URL for a given page. */
  private buildFeedUrl(tenant: string, page: number): string {
    const origin = hirehiveCareerOrigin(tenant);
    const params = new URLSearchParams({
      page: String(page),
      page_size: String(HIREHIVE_PAGE_SIZE),
      source: HIREHIVE_SOURCE,
    });
    return `${origin}/${HIREHIVE_JOBS_PATH}?${params.toString()}`;
  }

  /**
   * Assemble a fallback `{origin}/{id}` public detail URL for a role. Only used if a
   * future feed shape ever omits the canonical `hosted_url`.
   */
  private buildJobUrl(tenant: string, atsId: string): string {
    const origin = hirehiveCareerOrigin(tenant);
    return `${origin}/${encodeURIComponent(atsId)}`;
  }

  /** De-slugify + title-case the tenant token into a display company name. */
  private deriveSlugName(tenant: string): string {
    const base = tenant && tenant.trim() ? tenant.trim() : tenant;
    return base.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /**
   * Surface the role's location parts as a LocationDto, leaving location null when
   * nothing usable is present.
   */
  private extractLocation(job: HirehiveJob): LocationDto | null {
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
   * Detect remote roles from the structured employment-`type` token, then from the title,
   * location, or department text.
   */
  private detectRemote(
    item: HirehiveJobItem,
    title: string | null,
    location: string | null,
    department: string | null | undefined,
  ): boolean {
    const typeToken = this.cleanText(item.type?.type);
    if (typeToken && typeToken.toLowerCase().includes(HIREHIVE_REMOTE_TYPE)) {
      return true;
    }
    const haystacks: Array<string | null | undefined> = [title, location, department];
    for (const field of haystacks) {
      if (typeof field !== 'string') continue;
      if (HIREHIVE_REMOTE_REGEX.test(field)) return true;
    }
    return false;
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

  /** Trim a string, returning null for empty / non-string values. */
  private cleanText(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null;
    const v = value.trim();
    return v.length > 0 ? v : null;
  }
}
