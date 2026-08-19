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
  GUPY_ROOT_DOMAIN,
  GUPY_CAREER_HOST_SUFFIX,
  GUPY_INDEX_PATHS,
  GUPY_JOB_PATH,
  GUPY_DEFAULT_RESULTS,
  GUPY_MAX_PAGES,
  GUPY_DEFAULT_TIMEOUT_SECONDS,
  GUPY_HEADERS,
  GUPY_NEXT_DATA_REGEX,
  GUPY_REMOTE_WORKPLACE_TYPE,
  GUPY_REMOTE_REGEX,
  gupyCareerOrigin,
} from './gupy.constants';
import { GupyJob, GupyJobItem, GupyCareerPage, GupyNextData } from './gupy.types';

/**
 * Gupy ATS careers scraper — generic, multi-tenant.
 *
 * Gupy (gupy.io, Brazil — the largest recruitment / ATS in Brazil & LATAM) powers each
 * customer's branded, public, unauthenticated candidate-facing career site on the
 * shared host `https://{tenant}.gupy.io/`. The career-site landing page is a
 * server-rendered Next.js application that embeds the full set of open roles directly
 * in the HTML inside the Next.js data island:
 *
 *   <script id="__NEXT_DATA__" type="application/json">{ … }</script>
 *
 * whose `props.pageProps.jobs` array holds every open role. The adapter extracts that
 * embedded JSON island, reads `props.pageProps.jobs`, and maps each role — rather than
 * depending on a client-rendered DOM, a headless browser, or an authenticated REST API.
 * Each role's numeric `id` builds the canonical detail / apply URL `/jobs/{id}` and is
 * the stable ATS id; `props.pageProps.careerPage.name` is the tenant's display brand.
 *
 * The caller addresses a tenant by `companySlug` (e.g. `sicredi`) or by `companyUrl` (a
 * career-site URL whose host encodes the tenant slug). An unknown tenant, one with no
 * open roles, or an empty board degrades naturally to an empty result. A fetch error,
 * an HTTP 4xx, a DNS failure, or a malformed body degrades to an empty / partial result
 * rather than throwing, so a single tenant never nukes a batch run.
 */
@SourcePlugin({
  site: Site.GUPY,
  name: 'Gupy',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class GupyService implements IScraper {
  private readonly logger = new Logger(GupyService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for Gupy scraper');
      return new JobResponseDto([]);
    }

    const tenant = this.resolveTenant(companySlug, input.companyUrl);
    if (!tenant) {
      this.logger.warn('Could not resolve a Gupy tenant slug from input');
      return new JobResponseDto([]);
    }

    // Cap the per-request timeout so an unresponsive Gupy career host degrades
    // gracefully fast rather than hanging on the client's 60s default. Bound BOTH
    // keys: the no-proxy path keys off `timeout`, the proxy path off
    // `requestTimeout`. A caller may request a shorter timeout; we only cap.
    const timeoutSeconds = Math.min(
      input.requestTimeout ?? GUPY_DEFAULT_TIMEOUT_SECONDS,
      GUPY_DEFAULT_TIMEOUT_SECONDS,
    );
    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: timeoutSeconds,
      requestTimeout: timeoutSeconds,
    });
    client.setHeaders(GUPY_HEADERS);

    const resultsWanted = input.resultsWanted ?? GUPY_DEFAULT_RESULTS;
    const jobPosts: JobPostDto[] = [];

    try {
      this.logger.log(`Fetching Gupy jobs for tenant: ${tenant}`);

      const found = await this.fetchJobs(client, tenant);
      if (!found) {
        this.logger.log(`Gupy tenant "${tenant}" has no reachable open-roles board`);
        return new JobResponseDto([]);
      }

      const { jobs, companyName } = found;
      if (jobs.length === 0) {
        this.logger.log(`Gupy tenant "${tenant}" has no open roles`);
        return new JobResponseDto([]);
      }

      const seen = new Set<string>();
      for (const item of jobs) {
        if (jobPosts.length >= resultsWanted) break;
        try {
          const post = this.processItem(item, tenant, companyName, input.descriptionFormat, seen);
          if (post) jobPosts.push(post);
        } catch (err: any) {
          this.logger.warn(`Error processing Gupy role ${item?.id}: ${err.message}`);
        }
      }

      this.logger.log(`Gupy total: ${jobPosts.length} jobs for ${tenant}`);
      return new JobResponseDto(jobPosts);
    } catch (err: any) {
      this.logger.error(`Gupy scrape error for ${tenant}: ${err.message}`);
      // Partial results WITH a reason: jobs.length > 0 plus a diagnostic is
      // inferred as 'partial' upstream, so a mid-scrape failure is no longer
      // indistinguishable from a complete board.
      return new JobResponseDto(jobPosts, classifyScrapeError(err));
    }
  }

  /**
   * Probe the tenant's SSR career landing page across the known path variants until one
   * embeds a `__NEXT_DATA__` island with a jobs array. Returns the parsed roles and the
   * tenant's display brand name (from `careerPage.name`), or null when none respond.
   */
  private async fetchJobs(
    client: ReturnType<typeof createHttpClient>,
    tenant: string,
  ): Promise<{ jobs: GupyJobItem[]; companyName: string } | null> {
    const origin = gupyCareerOrigin(tenant);
    let attempts = 0;

    for (const path of GUPY_INDEX_PATHS) {
      if (attempts >= GUPY_MAX_PAGES) return null;
      attempts++;

      const url = path ? `${origin}/${path}` : `${origin}/`;
      const { data: html, hostReachable } = await this.fetchHtml(client, url, tenant);
      // A transport-level failure (DNS / refused / reset / timeout) means the tenant
      // host itself is unreachable — no other path can succeed, so abort the whole
      // probe sweep rather than burning a full timeout per combo.
      if (!hostReachable) return null;
      if (html == null) continue;

      const parsed = this.extractJobs(html);
      if (parsed == null) continue; // no __NEXT_DATA__ island / no jobs key — try next

      // A page exposing the jobs array is the right surface; return its roles (possibly
      // empty — an empty board is a valid "no roles" result) and the brand name.
      return parsed;
    }

    return null;
  }

  /**
   * GET a career-site URL as text. Returns `{ data, hostReachable }`:
   *  - `data` is the body, or null when the response carried no usable text / the host
   *    answered an HTTP error status (4xx / 5xx — a real, reachable host).
   *  - `hostReachable` is false ONLY for a transport-level failure (DNS / connection
   *    refused / reset / timeout), where the tenant host itself is unreachable and the
   *    caller should stop probing further path variations.
   * Never throws — every failure degrades gracefully.
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
        // The host answered an HTTP status (4xx path-not-found / 5xx) — it is reachable,
        // so the caller may still try other path variations.
        this.logger.warn(`Gupy board returned HTTP ${status} for ${tenant}`);
        return { data: null, hostReachable: true };
      }
      // No HTTP response → transport-level failure (DNS / refused / reset / timeout):
      // the tenant host is unreachable. Degrade gracefully and signal host-down.
      this.logger.warn(`Gupy board fetch failed for ${tenant}: ${err?.message ?? err}`);
      return { data: null, hostReachable: false };
    }
  }

  /**
   * Extract the open-roles array from the SSR landing HTML. The page embeds the Next.js
   * data island `<script id="__NEXT_DATA__" type="application/json">{ … }</script>`
   * whose `props.pageProps.jobs` is the role array (plain JSON — parsed directly, not a
   * JS string literal). Returns:
   *  - `{ jobs, companyName }` when the island is present + parseable (jobs possibly
   *    empty — an empty board is a valid "no roles" result).
   *  - `null` when the page carries no `__NEXT_DATA__` island or no `jobs` key (so the
   *    caller tries another path variant).
   */
  private extractJobs(html: string): { jobs: GupyJobItem[]; companyName: string } | null {
    GUPY_NEXT_DATA_REGEX.lastIndex = 0;
    const match = GUPY_NEXT_DATA_REGEX.exec(html);
    if (!match || !match[1]) return null;

    let data: GupyNextData;
    try {
      data = JSON.parse(match[1]) as GupyNextData;
    } catch (err: any) {
      this.logger.warn(`Gupy __NEXT_DATA__ JSON parse failed: ${err?.message ?? err}`);
      // Island present but unparseable — treat as no usable surface; let the probe move
      // on to the next path variant.
      return null;
    }

    const pageProps = data?.props?.pageProps;
    if (!pageProps || !Array.isArray(pageProps.jobs)) return null;

    return {
      jobs: pageProps.jobs as GupyJobItem[],
      companyName: this.deriveCompanyName(pageProps.careerPage),
    };
  }

  /** Map a parsed role → JobPostDto, deduping by ATS id. */
  private processItem(
    item: GupyJobItem,
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

  /** Build a normalised GupyJob from a parsed role. */
  private normaliseItem(item: GupyJobItem, tenant: string, brandName: string): GupyJob | null {
    const atsId = this.numToText(item.id);
    if (!atsId) return null;

    const url = this.buildJobUrl(tenant, atsId);
    const address = item.workplace?.address ?? null;
    const city = this.cleanText(address?.city);
    const state = this.cleanText(address?.stateShortName) ?? this.cleanText(address?.state);
    const country = this.cleanText(address?.country);
    const locationText = this.joinLocation(city, state, country);
    const department = this.cleanText(item.department);
    const title = this.cleanText(item.title);

    return {
      atsId,
      url,
      // The Gupy detail page hosts the apply flow inline; the canonical apply URL is the
      // detail URL itself.
      applyUrl: url,
      title,
      companyName: brandName || this.deriveSlugName(tenant),
      city,
      state,
      country,
      locationText,
      descriptionHtml: this.cleanText(item.description),
      department,
      datePosted: this.parseDate(item.publishedDate),
      isRemote: this.detectRemote(item, title, locationText, department),
    };
  }

  /** Map a normalised GupyJob → JobPostDto. */
  private processJob(job: GupyJob, tenant: string, format?: DescriptionFormat): JobPostDto | null {
    const title = job.title;
    if (!title) return null;

    const atsId = job.atsId;
    if (!atsId) return null;

    const jobUrl = job.url;
    if (!jobUrl) return null;

    const companyName = job.companyName ?? this.deriveSlugName(tenant);
    const description = this.formatDescription(job.descriptionHtml ?? null, format);

    return new JobPostDto({
      id: `gupy-${atsId}`,
      title,
      companyName,
      jobUrl,
      location: this.extractLocation(job),
      description,
      datePosted: job.datePosted ?? null,
      isRemote: job.isRemote ?? false,
      emails: extractEmails(description ?? ''),
      site: Site.GUPY,
      atsId,
      atsType: 'gupy',
      department: job.department ?? null,
      employmentType: null,
      applyUrl: job.applyUrl ?? jobUrl,
    });
  }

  /**
   * Convert the role description body per `descriptionFormat`. Gupy boards expose the
   * body as HTML when present, so HTML returns it as-is, Markdown converts it, and Plain
   * strips the tags.
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
   * on a `gupy.io` host has the tenant taken from its leading sub-domain label. Returns
   * an empty string when neither yields a tenant.
   */
  private resolveTenant(companySlug: string | undefined, companyUrl: string | undefined): string {
    if (companySlug && companySlug.trim()) {
      const slug = companySlug.trim();
      // A caller may also pass a full career-site URL as the slug.
      if (/^https?:\/\//i.test(slug) || slug.includes(GUPY_ROOT_DOMAIN)) {
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
   * Derive the tenant token from a Gupy career-site URL. The candidate-facing host is
   * `{tenant}.gupy.io`; the tenant is the leading sub-domain label.
   */
  private tenantFromUrl(value: string): string {
    const raw = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    try {
      const u = new URL(raw);
      const hostname = u.hostname.toLowerCase();
      if (!hostname.endsWith(GUPY_CAREER_HOST_SUFFIX)) {
        // Not a hosted career host — no derivable tenant.
        return '';
      }
      const label = hostname.slice(0, hostname.length - GUPY_CAREER_HOST_SUFFIX.length);
      // Guard against an empty / `www` / `portal` label (non-tenant hosts).
      if (!label || label === 'www' || label === 'portal') return '';
      return label.toLowerCase();
    } catch {
      // Malformed URL — no tenant.
    }
    return '';
  }

  /** Assemble the canonical `{origin}/jobs/{id}` public detail URL for a role. */
  private buildJobUrl(tenant: string, atsId: string): string {
    const origin = gupyCareerOrigin(tenant);
    return `${origin}/${GUPY_JOB_PATH}/${encodeURIComponent(atsId)}`;
  }

  /** Prefer the career-page brand name; fall back to the de-slugified tenant token. */
  private deriveCompanyName(careerPage: GupyCareerPage | null | undefined): string {
    const name = this.cleanText(careerPage?.name) ?? this.cleanText(careerPage?.publicationName);
    return name ?? '';
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
  private extractLocation(job: GupyJob): LocationDto | null {
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
   * Detect remote roles from the structured `workplaceType` flag, then from the title,
   * location, or department text.
   */
  private detectRemote(
    item: GupyJobItem,
    title: string | null,
    location: string | null,
    department: string | null | undefined,
  ): boolean {
    const workplaceType = this.cleanText(item.workplace?.workplaceType);
    if (workplaceType && workplaceType.toLowerCase() === GUPY_REMOTE_WORKPLACE_TYPE) {
      return true;
    }
    const haystacks: Array<string | null | undefined> = [title, location, department];
    for (const field of haystacks) {
      if (typeof field !== 'string') continue;
      if (GUPY_REMOTE_REGEX.test(field)) return true;
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
}
