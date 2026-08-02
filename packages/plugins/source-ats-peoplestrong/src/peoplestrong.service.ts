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
  PEOPLESTRONG_ROOT_DOMAIN,
  PEOPLESTRONG_CAREER_HOST_SUFFIX,
  PEOPLESTRONG_BOARD_PATHS,
  PEOPLESTRONG_INDEX_PATHS,
  PEOPLESTRONG_JOB_PATH,
  PEOPLESTRONG_JOB_DETAIL_SEGMENT,
  PEOPLESTRONG_DEFAULT_RESULTS,
  PEOPLESTRONG_MAX_PAGES,
  PEOPLESTRONG_DEFAULT_TIMEOUT_SECONDS,
  PEOPLESTRONG_HEADERS,
  PEOPLESTRONG_DATA_ISLAND_REGEX,
  PEOPLESTRONG_JSON_LD_REGEX,
  PEOPLESTRONG_REMOTE_REGEX,
  peopleStrongCareerOrigin,
} from './peoplestrong.constants';
import {
  PeopleStrongJob,
  PeopleStrongJobItem,
  PeopleStrongBoardResponse,
  PeopleStrongJsonLd,
} from './peoplestrong.types';

/**
 * PeopleStrong ATS candidate-portal scraper — generic, multi-tenant.
 *
 * PeopleStrong (peoplestrong.com — a large India / APAC enterprise HCM + Talent
 * Acquisition suite) powers each customer's branded, public, unauthenticated
 * candidate-facing career portal on the shared host `https://{tenant}.peoplestrong.com/`.
 * The portal is a CLIENT-RENDERED single-page application: the served HTML is a thin
 * shell and the open-roles board is hydrated from a tenant-scoped JSON endpoint. The
 * adapter therefore probes the documented candidate-portal JSON board endpoints under the
 * tenant origin (no auth, no API key, no headless browser) and — defensively — scans any
 * served HTML for an embedded JSON data island or schema.org `JobPosting` JSON-LD, should
 * a tenant pre-render its board. Each role's stable id builds the canonical detail / apply
 * URL `/job/detail/{jobId}` and is the ATS id.
 *
 * The caller addresses a tenant by `companySlug` (e.g. `exlcareers`) or by `companyUrl` (a
 * candidate-portal URL whose host encodes the tenant slug). An unknown tenant, one with no
 * open roles, or an empty board degrades naturally to an empty result. A fetch error, an
 * HTTP 4xx/5xx, a DNS failure, or a malformed body degrades to an empty / partial result
 * rather than throwing, so a single tenant never nukes a batch run.
 *
 * Surface confidence (researched 2026-06-03, no authentication): the platform, the
 * `{tenant}.peoplestrong.com` addressing, and the per-role URL `/job/detail/{jobId}` are
 * CONFIRMED against real named tenants (`exlcareers`, `ummeed-careers`, `sobha-careers`,
 * …). The JSON board surface EXISTS (it answered auth/CSRF-guarded statuses anonymously)
 * but its open-roles payload could not be confirmed anonymously live, so the board shape
 * is DOCUMENTED-BUT-UNVERIFIED and the adapter is intentionally defensive (verified=false).
 */
@SourcePlugin({
  site: Site.PEOPLESTRONG,
  name: 'PeopleStrong',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class PeopleStrongService implements IScraper {
  private readonly logger = new Logger(PeopleStrongService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for PeopleStrong scraper');
      return new JobResponseDto([]);
    }

    const tenant = this.resolveTenant(companySlug, input.companyUrl);
    if (!tenant) {
      this.logger.warn('Could not resolve a PeopleStrong tenant slug from input');
      return new JobResponseDto([]);
    }

    // Cap the per-request timeout so an unresponsive PeopleStrong candidate host degrades
    // gracefully fast rather than hanging on the client's 60s default. Bound BOTH keys:
    // the no-proxy path keys off `timeout`, the proxy path off `requestTimeout`. A caller
    // may request a shorter timeout; we only cap.
    const timeoutSeconds = Math.min(
      input.requestTimeout ?? PEOPLESTRONG_DEFAULT_TIMEOUT_SECONDS,
      PEOPLESTRONG_DEFAULT_TIMEOUT_SECONDS,
    );
    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: timeoutSeconds,
      requestTimeout: timeoutSeconds,
    });
    client.setHeaders(PEOPLESTRONG_HEADERS);

    const resultsWanted = input.resultsWanted ?? PEOPLESTRONG_DEFAULT_RESULTS;
    const jobPosts: JobPostDto[] = [];

    try {
      this.logger.log(`Fetching PeopleStrong jobs for tenant: ${tenant}`);

      const found = await this.fetchJobs(client, tenant);
      if (!found) {
        this.logger.log(
          `PeopleStrong tenant "${tenant}" has no reachable open-roles board`,
        );
        return new JobResponseDto([]);
      }

      const { jobs, companyName } = found;
      if (jobs.length === 0) {
        this.logger.log(`PeopleStrong tenant "${tenant}" has no open roles`);
        return new JobResponseDto([]);
      }

      const seen = new Set<string>();
      for (const item of jobs) {
        if (jobPosts.length >= resultsWanted) break;
        try {
          const post = this.processItem(
            item,
            tenant,
            companyName,
            input.descriptionFormat,
            seen,
          );
          if (post) jobPosts.push(post);
        } catch (err: any) {
          this.logger.warn(
            `Error processing PeopleStrong role ${this.itemId(item)}: ${err.message}`,
          );
        }
      }

      this.logger.log(`PeopleStrong total: ${jobPosts.length} jobs for ${tenant}`);
      return new JobResponseDto(jobPosts);
    } catch (err: any) {
      this.logger.error(`PeopleStrong scrape error for ${tenant}: ${err.message}`);
      return new JobResponseDto(jobPosts); // partial results
    }
  }

  /**
   * Probe the tenant's candidate-portal board: first the documented JSON board endpoints,
   * then — defensively — the served HTML landing pages (embedded data island / JSON-LD).
   * Returns the parsed roles and the tenant's display brand name, or null when none
   * respond / the host is unreachable.
   */
  private async fetchJobs(
    client: ReturnType<typeof createHttpClient>,
    tenant: string,
  ): Promise<{ jobs: PeopleStrongJobItem[]; companyName: string } | null> {
    const origin = peopleStrongCareerOrigin(tenant);
    let attempts = 0;

    // 1) Documented candidate-portal JSON board endpoints (the SPA's hydration source).
    for (const path of PEOPLESTRONG_BOARD_PATHS) {
      if (attempts >= PEOPLESTRONG_MAX_PAGES) return null;
      attempts++;

      const url = `${origin}/${path}`;
      const { data, hostReachable } = await this.fetchJson(client, url, tenant);
      // A transport-level failure (DNS / refused / reset / timeout) means the tenant host
      // itself is unreachable — no other path can succeed, so abort the whole sweep
      // rather than burning a full timeout per combo.
      if (!hostReachable) return null;
      if (data == null) continue;

      const parsed = this.extractJobsFromJson(data, tenant);
      if (parsed == null) continue; // no roles array in this envelope — try next endpoint
      return parsed;
    }

    // 2) Defensive HTML fallback (a pre-rendered tenant that embeds its board / JSON-LD).
    for (const path of PEOPLESTRONG_INDEX_PATHS) {
      if (attempts >= PEOPLESTRONG_MAX_PAGES) return null;
      attempts++;

      const url = path ? `${origin}/${path}` : `${origin}/`;
      const { data: html, hostReachable } = await this.fetchHtml(client, url, tenant);
      if (!hostReachable) return null;
      if (html == null) continue;

      const parsed = this.extractJobsFromHtml(html, tenant);
      if (parsed == null) continue; // no island / JSON-LD roles — try next path variant
      return parsed;
    }

    return null;
  }

  /**
   * GET a candidate-portal URL as parsed JSON. Returns `{ data, hostReachable }`:
   *  - `data` is the parsed JSON body, or null when the response carried no usable JSON /
   *    the host answered an HTTP error status (4xx / 5xx — a real, reachable host).
   *  - `hostReachable` is false ONLY for a transport-level failure (DNS / connection
   *    refused / reset / timeout). Never throws — every failure degrades gracefully.
   */
  private async fetchJson(
    client: ReturnType<typeof createHttpClient>,
    url: string,
    tenant: string,
  ): Promise<{ data: unknown | null; hostReachable: boolean }> {
    try {
      const response = await client.get<unknown>(url, { responseType: 'json' });
      const body = response.data;
      if (body == null) return { data: null, hostReachable: true };
      // Some hosts answer JSON content with a text/html content-type; coerce a JSON string.
      if (typeof body === 'string') {
        try {
          return { data: JSON.parse(body), hostReachable: true };
        } catch {
          return { data: null, hostReachable: true };
        }
      }
      return { data: body, hostReachable: true };
    } catch (err: any) {
      const status = err?.response?.status;
      if (status) {
        // The host answered an HTTP status (4xx not-found / 403/500 auth-guarded board) —
        // it is reachable, so the caller may still try other endpoints / the HTML fallback.
        this.logger.warn(`PeopleStrong board returned HTTP ${status} for ${tenant}`);
        return { data: null, hostReachable: true };
      }
      // No HTTP response → transport-level failure: the tenant host is unreachable.
      this.logger.warn(
        `PeopleStrong board fetch failed for ${tenant}: ${err?.message ?? err}`,
      );
      return { data: null, hostReachable: false };
    }
  }

  /**
   * GET a candidate-portal URL as text (HTML fallback). Same `{ data, hostReachable }`
   * contract as `fetchJson`. Never throws.
   */
  private async fetchHtml(
    client: ReturnType<typeof createHttpClient>,
    url: string,
    tenant: string,
  ): Promise<{ data: string | null; hostReachable: boolean }> {
    try {
      const response = await client.get<string>(url, { responseType: 'text' });
      return {
        data: typeof response.data === 'string' ? response.data : null,
        hostReachable: true,
      };
    } catch (err: any) {
      const status = err?.response?.status;
      if (status) {
        this.logger.warn(`PeopleStrong page returned HTTP ${status} for ${tenant}`);
        return { data: null, hostReachable: true };
      }
      this.logger.warn(
        `PeopleStrong page fetch failed for ${tenant}: ${err?.message ?? err}`,
      );
      return { data: null, hostReachable: false };
    }
  }

  /**
   * Narrow a parsed candidate-portal JSON board response to a roles array. The roles array
   * is exposed under a variety of keys across deployments (or the top level may itself be
   * the array), so we probe the common carriers defensively. Returns:
   *  - `{ jobs, companyName }` when a roles array is found (possibly empty — an empty board
   *    is a valid "no roles" result).
   *  - `null` when no roles array is present (so the caller tries another endpoint).
   */
  private extractJobsFromJson(
    data: unknown,
    tenant: string,
  ): { jobs: PeopleStrongJobItem[]; companyName: string } | null {
    // Top level is itself the array of roles.
    if (Array.isArray(data)) {
      return { jobs: data as PeopleStrongJobItem[], companyName: '' };
    }
    if (!data || typeof data !== 'object') return null;

    const env = data as PeopleStrongBoardResponse & Record<string, unknown>;
    const jobs = this.pickJobsArray(env);
    if (jobs == null) return null;

    const companyName =
      this.cleanText(env.companyName) ??
      this.cleanText(env.tenantName) ??
      this.cleanText(env.organizationName) ??
      '';
    return { jobs, companyName };
  }

  /** Probe the common roles-array carriers of a board envelope; null when none is an array. */
  private pickJobsArray(
    env: PeopleStrongBoardResponse & Record<string, unknown>,
  ): PeopleStrongJobItem[] | null {
    if (Array.isArray(env.jobs)) return env.jobs as PeopleStrongJobItem[];
    if (Array.isArray(env.openings)) return env.openings as PeopleStrongJobItem[];
    if (Array.isArray(env.requisitions)) return env.requisitions as PeopleStrongJobItem[];
    if (Array.isArray(env.results)) return env.results as PeopleStrongJobItem[];
    if (Array.isArray(env.records)) return env.records as PeopleStrongJobItem[];
    if (Array.isArray(env.data)) return env.data as PeopleStrongJobItem[];
    // `data` may itself wrap the array (`{ data: { jobs: [...] } }`).
    const nested = env.data;
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      const inner = (nested as { jobs?: unknown }).jobs;
      if (Array.isArray(inner)) return inner as PeopleStrongJobItem[];
    }
    return null;
  }

  /**
   * Defensive HTML fallback: extract roles from a pre-rendered candidate-portal page —
   * first an embedded JSON data island, then schema.org `JobPosting` JSON-LD blocks.
   * Returns `{ jobs, companyName }` when roles are found, else null (try next path).
   */
  private extractJobsFromHtml(
    html: string,
    tenant: string,
  ): { jobs: PeopleStrongJobItem[]; companyName: string } | null {
    // a) Embedded JSON data island (an SPA that bootstraps state into the page).
    PEOPLESTRONG_DATA_ISLAND_REGEX.lastIndex = 0;
    const islandMatch = PEOPLESTRONG_DATA_ISLAND_REGEX.exec(html);
    if (islandMatch && islandMatch[1]) {
      try {
        const parsed = this.extractJobsFromJson(JSON.parse(islandMatch[1]), tenant);
        if (parsed) return parsed;
      } catch (err: any) {
        this.logger.warn(
          `PeopleStrong data island JSON parse failed for ${tenant}: ${err?.message ?? err}`,
        );
      }
    }

    // b) schema.org JSON-LD JobPosting blocks.
    const ldJobs = this.extractJobsFromJsonLd(html);
    if (ldJobs.length > 0) return { jobs: ldJobs, companyName: '' };

    return null;
  }

  /** Collect `JobPosting` JSON-LD blocks from a pre-rendered page into role items. */
  private extractJobsFromJsonLd(html: string): PeopleStrongJobItem[] {
    const items: PeopleStrongJobItem[] = [];
    PEOPLESTRONG_JSON_LD_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = PEOPLESTRONG_JSON_LD_REGEX.exec(html)) !== null) {
      const raw = match[1];
      if (!raw) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        continue; // a malformed JSON-LD block is skipped, never throws
      }
      // A block may be a single object, an array, or a @graph wrapper.
      const candidates: unknown[] = Array.isArray(parsed)
        ? parsed
        : this.isObject(parsed) && Array.isArray((parsed as { '@graph'?: unknown })['@graph'])
          ? ((parsed as { '@graph': unknown[] })['@graph'] as unknown[])
          : [parsed];
      for (const candidate of candidates) {
        const item = this.jsonLdToItem(candidate);
        if (item) items.push(item);
      }
    }
    return items;
  }

  /** Map a single JSON-LD node to a role item when it is a `JobPosting`. */
  private jsonLdToItem(node: unknown): PeopleStrongJobItem | null {
    if (!this.isObject(node)) return null;
    const ld = node as PeopleStrongJsonLd;
    const type = ld['@type'];
    const isJobPosting = Array.isArray(type)
      ? type.some((t) => typeof t === 'string' && t.toLowerCase() === 'jobposting')
      : typeof type === 'string' && type.toLowerCase() === 'jobposting';
    if (!isJobPosting) return null;

    const loc = Array.isArray(ld.jobLocation) ? ld.jobLocation[0] : ld.jobLocation;
    const address = loc?.address ?? null;
    const country = address?.addressCountry;
    const countryName =
      typeof country === 'string' ? country : this.cleanText(country?.name);

    const idVal =
      ld.identifier && typeof ld.identifier === 'object'
        ? (ld.identifier as { value?: string | number | null }).value
        : (ld.identifier as string | number | null | undefined);

    return {
      id: idVal ?? null,
      title: ld.title ?? null,
      city: address?.addressLocality ?? null,
      state: address?.addressRegion ?? null,
      country: countryName ?? null,
      description: ld.description ?? null,
      postedDate: ld.datePosted ?? null,
      employmentType: Array.isArray(ld.employmentType)
        ? ld.employmentType[0]
        : ld.employmentType ?? null,
      url: ld.url ?? null,
    };
  }

  /** Map a parsed role → JobPostDto, deduping by ATS id. */
  private processItem(
    item: PeopleStrongJobItem,
    tenant: string,
    brandName: string,
    format: DescriptionFormat | undefined,
    seen: Set<string>,
  ): JobPostDto | null {
    const job = this.normaliseItem(item, tenant, brandName);
    if (!job) return null;
    if (seen.has(job.atsId)) return null;
    seen.add(job.atsId);
    return this.processJob(job, tenant, format);
  }

  /** Build a normalised PeopleStrongJob from a parsed role. */
  private normaliseItem(
    item: PeopleStrongJobItem,
    tenant: string,
    brandName: string,
  ): PeopleStrongJob | null {
    const atsId = this.itemId(item);
    if (!atsId) return null;

    const url = this.buildJobUrl(tenant, atsId, item);
    const city = this.cleanText(item.city);
    const state = this.cleanText(item.state);
    const country = this.cleanText(item.country);
    const locationText =
      this.cleanText(item.location) ??
      this.cleanText(item.jobLocation) ??
      this.joinLocation(city, state, country);
    const department =
      this.cleanText(item.department) ??
      this.cleanText(item.businessUnit) ??
      this.cleanText(item.function);
    const title =
      this.cleanText(item.title) ??
      this.cleanText(item.jobTitle) ??
      this.cleanText(item.designation);

    return {
      atsId,
      url,
      // The PeopleStrong detail page hosts the apply flow inline; the canonical apply URL
      // is the detail URL itself (unless the board carries an explicit one).
      applyUrl: this.cleanText(item.applyUrl) ?? url,
      title,
      companyName: brandName || this.deriveSlugName(tenant),
      city,
      state,
      country,
      locationText,
      descriptionHtml:
        this.cleanText(item.description) ?? this.cleanText(item.jobDescription),
      department,
      employmentType:
        this.cleanText(item.employmentType) ?? this.cleanText(item.jobType),
      datePosted: this.parseDate(
        item.postedDate ?? item.createdDate ?? item.publishedDate,
      ),
      isRemote: this.detectRemote(item, title, locationText, department),
    };
  }

  /** Map a normalised PeopleStrongJob → JobPostDto. */
  private processJob(
    job: PeopleStrongJob,
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
      id: `peoplestrong-${atsId}`,
      title,
      companyName,
      jobUrl,
      location: this.extractLocation(job),
      description,
      datePosted: job.datePosted ?? null,
      isRemote: job.isRemote ?? false,
      emails: extractEmails(description ?? ''),
      site: Site.PEOPLESTRONG,
      atsId,
      atsType: 'peoplestrong',
      department: job.department ?? null,
      employmentType: job.employmentType ?? null,
      applyUrl: job.applyUrl ?? jobUrl,
    });
  }

  /**
   * Convert the role description body per `descriptionFormat`. PeopleStrong boards expose
   * the body as HTML when present, so HTML returns it as-is, Markdown converts it, and
   * Plain strips the tags.
   */
  private formatDescription(html: string | null, format?: DescriptionFormat): string | null {
    if (!html) return null;
    if (format === DescriptionFormat.HTML) return html;
    if (format === DescriptionFormat.MARKDOWN) return markdownConverter(html) ?? html;
    return htmlToPlainText(html) ?? html;
  }

  /**
   * Resolve the tenant slug. An explicit `companySlug` is used directly (a bare
   * candidate-portal URL passed as the slug is reduced to its tenant token); a
   * `companyUrl` on a `peoplestrong.com` host has the tenant taken from its leading
   * sub-domain label. Returns an empty string when neither yields a tenant.
   */
  private resolveTenant(companySlug: string | undefined, companyUrl: string | undefined): string {
    if (companySlug && companySlug.trim()) {
      const slug = companySlug.trim();
      // A caller may also pass a full candidate-portal URL as the slug.
      if (/^https?:\/\//i.test(slug) || slug.includes(PEOPLESTRONG_ROOT_DOMAIN)) {
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
   * Derive the tenant token from a PeopleStrong candidate-portal URL. The candidate-facing
   * host is `{tenant}.peoplestrong.com`; the tenant is the leading sub-domain label.
   */
  private tenantFromUrl(value: string): string {
    const raw = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    try {
      const u = new URL(raw);
      const hostname = u.hostname.toLowerCase();
      if (!hostname.endsWith(PEOPLESTRONG_CAREER_HOST_SUFFIX)) {
        // Not a hosted candidate host — no derivable tenant.
        return '';
      }
      const label = hostname.slice(
        0,
        hostname.length - PEOPLESTRONG_CAREER_HOST_SUFFIX.length,
      );
      // Guard against an empty / `www` / `api` label (non-tenant hosts).
      if (!label || label === 'www' || label === 'api') return '';
      return label.toLowerCase();
    } catch {
      // Malformed URL — no tenant.
    }
    return '';
  }

  /**
   * Assemble the canonical `{origin}/job/detail/{jobId}` public detail URL for a role,
   * preferring an absolute URL the board carries directly.
   */
  private buildJobUrl(tenant: string, atsId: string, item: PeopleStrongJobItem): string {
    const explicit = this.cleanText(item.url);
    if (explicit && /^https?:\/\//i.test(explicit)) return explicit;
    const origin = peopleStrongCareerOrigin(tenant);
    return `${origin}/${PEOPLESTRONG_JOB_PATH}/${PEOPLESTRONG_JOB_DETAIL_SEGMENT}/${encodeURIComponent(
      atsId,
    )}`;
  }

  /** Coerce a role's id from its aliased id fields, or null when none is usable. */
  private itemId(item: PeopleStrongJobItem): string | null {
    return (
      this.numToText(item.id) ??
      this.numToText(item.jobId) ??
      this.numToText(item.requisitionId) ??
      this.cleanText(item.code)
    );
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
  private extractLocation(job: PeopleStrongJob): LocationDto | null {
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
   * Detect remote roles from the structured work-mode token, then from the title,
   * location, or department text.
   */
  private detectRemote(
    item: PeopleStrongJobItem,
    title: string | null,
    location: string | null,
    department: string | null | undefined,
  ): boolean {
    const workMode =
      this.cleanText(item.workMode) ?? this.cleanText(item.workplaceType);
    if (workMode && PEOPLESTRONG_REMOTE_REGEX.test(workMode)) return true;
    const haystacks: Array<string | null | undefined> = [title, location, department];
    for (const field of haystacks) {
      if (typeof field !== 'string') continue;
      if (PEOPLESTRONG_REMOTE_REGEX.test(field)) return true;
    }
    return false;
  }

  /**
   * Parse a timestamp value into a YYYY-MM-DD string. Non-absolute / unparseable values
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

  /** Coerce a numeric / string id field into trimmed text, or null when empty. */
  private numToText(value: number | string | null | undefined): string | null {
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    return this.cleanText(typeof value === 'string' ? value : null);
  }

  /** Trim a string, returning null for empty / non-string values. */
  private cleanText(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null;
    const v = value.trim();
    return v.length > 0 ? v : null;
  }

  /** Narrow an unknown to a plain object. */
  private isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
  }
}
