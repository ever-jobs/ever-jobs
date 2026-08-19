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
  SAGEPEOPLE_ROOT_DOMAIN,
  SAGEPEOPLE_CAREER_HOST_SUFFIX,
  SAGEPEOPLE_SITE_PATHS,
  SAGEPEOPLE_JOB_LIST_PAGE,
  SAGEPEOPLE_JOB_PAGE,
  SAGEPEOPLE_DEFAULT_PORTAL,
  SAGEPEOPLE_DEFAULT_RESULTS,
  SAGEPEOPLE_MAX_PAGES,
  SAGEPEOPLE_DEFAULT_TIMEOUT_SECONDS,
  SAGEPEOPLE_HEADERS,
  SAGEPEOPLE_JOB_ANCHOR_REGEX,
  SAGEPEOPLE_VACANCY_NO_REGEX,
  SAGEPEOPLE_PORTAL_REGEX,
  SAGEPEOPLE_PAGINATION_REGEX,
  SAGEPEOPLE_REMOTE_REGEX,
  sagePeopleCareerOrigin,
} from './sagepeople.constants';
import { SagePeopleJob, SagePeopleVacancy, SagePeopleBoardPage } from './sagepeople.types';

/**
 * Sage People (formerly Fairsail) ATS careers scraper — generic, multi-tenant.
 *
 * Sage People (sage.com/people — a UK/EU-rooted enterprise cloud HCM built on the
 * Salesforce Force.com platform) powers each customer's branded, public,
 * unauthenticated candidate-facing applicant portal as a Salesforce Site on the shared
 * host `https://{tenant}.my.salesforce-sites.com/{path}/`, served by the Sage People
 * Recruit managed package (`fRecruit__` namespace). The open-roles board
 * (`fRecruit__ApplyJobList`) is a server-rendered Visualforce page that embeds the full
 * set of open roles directly in the HTML as a table whose rows each link to a role's
 * detail / apply page:
 *
 *   <a href="/{path}/fRecruit__ApplyJob?vacancyNo=VN4027&portal=English">Job Title</a>
 *
 * The adapter fetches the board HTML and harvests those anchors — each `vacancyNo`
 * (e.g. `VN4027`) is the stable per-role ATS id and the canonical detail-URL key — and
 * sweeps the board's server-side pagination ("Page N of M"), rather than depending on a
 * client-rendered DOM, a headless browser, or an authenticated Salesforce API. The role
 * title is the anchor text; the de-slugified tenant Salesforce-Site label is the brand.
 *
 * The caller addresses a tenant by `companySlug` (e.g. `acteonpeopleportal`) or by
 * `companyUrl` (a portal URL whose host encodes the tenant slug and whose first path
 * segment is the site path). An unknown tenant, one with no open roles, or an empty
 * board degrades naturally to an empty result. A fetch error, an HTTP 4xx, a DNS
 * failure, or a malformed body degrades to an empty / partial result rather than
 * throwing, so a single tenant never nukes a batch run.
 */
@SourcePlugin({
  site: Site.SAGEPEOPLE,
  name: 'Sage People',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class SagePeopleService implements IScraper {
  private readonly logger = new Logger(SagePeopleService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for Sage People scraper');
      return new JobResponseDto([]);
    }

    const tenant = this.resolveTenant(companySlug, input.companyUrl);
    if (!tenant) {
      this.logger.warn('Could not resolve a Sage People tenant slug from input');
      return new JobResponseDto([]);
    }

    // Cap the per-request timeout so an unresponsive Salesforce-Sites host degrades
    // gracefully fast rather than hanging on the client's 60s default. Bound BOTH
    // keys: the no-proxy path keys off `timeout`, the proxy path off
    // `requestTimeout`. A caller may request a shorter timeout; we only cap.
    const timeoutSeconds = Math.min(
      input.requestTimeout ?? SAGEPEOPLE_DEFAULT_TIMEOUT_SECONDS,
      SAGEPEOPLE_DEFAULT_TIMEOUT_SECONDS,
    );
    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: timeoutSeconds,
      requestTimeout: timeoutSeconds,
    });
    client.setHeaders(SAGEPEOPLE_HEADERS);

    const resultsWanted = input.resultsWanted ?? SAGEPEOPLE_DEFAULT_RESULTS;
    const companyName = this.deriveSlugName(tenant);
    const jobPosts: JobPostDto[] = [];

    try {
      this.logger.log(`Fetching Sage People jobs for tenant: ${tenant}`);

      const vacancies = await this.fetchVacancies(client, tenant, resultsWanted);
      if (vacancies.length === 0) {
        this.logger.log(`Sage People tenant "${tenant}" has no reachable open-roles board`);
        return new JobResponseDto([]);
      }

      const seen = new Set<string>();
      for (const vacancy of vacancies) {
        if (jobPosts.length >= resultsWanted) break;
        try {
          const post = this.processVacancy(
            vacancy,
            tenant,
            companyName,
            input.descriptionFormat,
            seen,
          );
          if (post) jobPosts.push(post);
        } catch (err: any) {
          this.logger.warn(
            `Error processing Sage People role ${vacancy?.vacancyNo}: ${err.message}`,
          );
        }
      }

      this.logger.log(`Sage People total: ${jobPosts.length} jobs for ${tenant}`);
      return new JobResponseDto(jobPosts);
    } catch (err: any) {
      this.logger.error(`Sage People scrape error for ${tenant}: ${err.message}`);
      // Partial results WITH a reason: jobs.length > 0 plus a diagnostic is
      // inferred as 'partial' upstream, so a mid-scrape failure is no longer
      // indistinguishable from a complete board.
      return new JobResponseDto(jobPosts, classifyScrapeError(err));
    }
  }

  /**
   * Probe the tenant's SSR Recruit board across the known site-path variants until one
   * yields role anchors, then sweep that board's server-side pagination. Returns the
   * harvested, de-duplicated roles (possibly empty — an empty board is a valid "no roles"
   * result), bounded by the page cap and by `resultsWanted`.
   */
  private async fetchVacancies(
    client: ReturnType<typeof createHttpClient>,
    tenant: string,
    resultsWanted: number,
  ): Promise<SagePeopleVacancy[]> {
    let pagesFetched = 0;

    for (const path of SAGEPEOPLE_SITE_PATHS) {
      if (pagesFetched >= SAGEPEOPLE_MAX_PAGES) break;
      pagesFetched++;

      // Fetch the first board page under this site-path candidate.
      const url = this.buildBoardUrl(tenant, path, 1);
      const { data: html, hostReachable } = await this.fetchHtml(client, url, tenant);
      // A transport-level failure (DNS / refused / reset / timeout) means the tenant host
      // itself is unreachable — no other path can succeed, so abort the whole probe sweep
      // rather than burning a full timeout per combo.
      if (!hostReachable) return [];
      if (html == null) continue; // HTTP 4xx/5xx on this path — try the next site-path

      const first = this.parseBoardPage(html, path);
      if (first.vacancies.length === 0) continue; // not the board / empty under this path

      // Found the live board under this site-path. Harvest page 1, then sweep the rest of
      // the server-side pagination (bounded by the page cap and by resultsWanted).
      const collected: SagePeopleVacancy[] = [];
      const seen = new Set<string>();
      this.collectUnique(first.vacancies, collected, seen);

      const totalPages = Math.max(1, first.totalPages);
      for (let page = 2; page <= totalPages; page++) {
        if (pagesFetched >= SAGEPEOPLE_MAX_PAGES) break;
        if (collected.length >= resultsWanted) break;
        pagesFetched++;

        const pageUrl = this.buildBoardUrl(tenant, path, page);
        const { data: pageHtml, hostReachable: pageReachable } = await this.fetchHtml(
          client,
          pageUrl,
          tenant,
        );
        if (!pageReachable) break; // host went away mid-sweep — keep what we have
        if (pageHtml == null) continue;

        const parsed = this.parseBoardPage(pageHtml, path);
        if (parsed.vacancies.length === 0) break; // ran off the end of the board
        this.collectUnique(parsed.vacancies, collected, seen);
      }

      return collected;
    }

    return [];
  }

  /**
   * GET a portal URL as text. Returns `{ data, hostReachable }`:
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
        this.logger.warn(`Sage People board returned HTTP ${status} for ${tenant}`);
        return { data: null, hostReachable: true };
      }
      // No HTTP response → transport-level failure (DNS / refused / reset / timeout): the
      // tenant host is unreachable. Degrade gracefully and signal host-down.
      this.logger.warn(
        `Sage People board fetch failed for ${tenant}: ${err?.message ?? err}`,
      );
      return { data: null, hostReachable: false };
    }
  }

  /**
   * Parse one SSR board page: harvest every `fRecruit__ApplyJob?vacancyNo=…` anchor as a
   * role, and read the board's "Page N of M" total so the caller knows how far to sweep.
   * Returns `{ vacancies, totalPages, path }` — an empty `vacancies` array means this was
   * not the board (or an empty board) under the given site-path.
   */
  private parseBoardPage(html: string, path: string): SagePeopleBoardPage {
    const vacancies: SagePeopleVacancy[] = [];
    const seen = new Set<string>();

    SAGEPEOPLE_JOB_ANCHOR_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = SAGEPEOPLE_JOB_ANCHOR_REGEX.exec(html)) !== null) {
      const href = match[1];
      const innerHtml = match[2];
      if (!href) continue;

      const vacancyNo = this.extractVacancyNo(href);
      if (!vacancyNo) continue;
      // Dedup within the page — Sage People rows can render the same vacancy anchor twice
      // (title cell + an explicit "Apply" cell).
      if (seen.has(vacancyNo)) continue;
      seen.add(vacancyNo);

      vacancies.push({
        vacancyNo,
        href,
        title: this.stripTags(innerHtml),
        portal: this.extractPortal(href),
        city: null,
        country: null,
      });
    }

    return {
      vacancies,
      totalPages: this.parseTotalPages(html),
      path,
    };
  }

  /** Map a harvested role → JobPostDto, deduping by ATS id. */
  private processVacancy(
    vacancy: SagePeopleVacancy,
    tenant: string,
    brandName: string,
    format: DescriptionFormat | undefined,
    seen: Set<string>,
  ): JobPostDto | null {
    const job = this.normaliseVacancy(vacancy, tenant, brandName);
    if (!job) return null;
    if (seen.has(job.atsId)) return null;
    seen.add(job.atsId);
    return this.processJob(job, tenant, format);
  }

  /** Build a normalised SagePeopleJob from a harvested role. */
  private normaliseVacancy(
    vacancy: SagePeopleVacancy,
    tenant: string,
    brandName: string,
  ): SagePeopleJob | null {
    const atsId = this.cleanText(vacancy.vacancyNo);
    if (!atsId) return null;

    const url = this.buildJobUrl(tenant, vacancy);
    const city = this.cleanText(vacancy.city);
    const country = this.cleanText(vacancy.country);
    const locationText = this.joinLocation(city, null, country);
    const title = this.cleanText(vacancy.title);

    return {
      atsId,
      url,
      // The Sage People detail page hosts the apply flow inline; the canonical apply URL
      // is the detail URL itself.
      applyUrl: url,
      title,
      companyName: brandName || this.deriveSlugName(tenant),
      city,
      state: null,
      country,
      locationText,
      // The board list page is lightweight (id / title / location); the full description
      // lives on the per-role detail page and is mapped null here, degrading gracefully.
      descriptionHtml: null,
      department: null,
      datePosted: null,
      isRemote: this.detectRemote(title, locationText),
    };
  }

  /** Map a normalised SagePeopleJob → JobPostDto. */
  private processJob(
    job: SagePeopleJob,
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
      id: `sagepeople-${atsId}`,
      title,
      companyName,
      jobUrl,
      location: this.extractLocation(job),
      description,
      datePosted: job.datePosted ?? null,
      isRemote: job.isRemote ?? false,
      emails: extractEmails(description ?? ''),
      site: Site.SAGEPEOPLE,
      atsId,
      atsType: 'sagepeople',
      department: job.department ?? null,
      employmentType: null,
      applyUrl: job.applyUrl ?? jobUrl,
    });
  }

  /**
   * Convert the role description body per `descriptionFormat`. Sage People detail bodies
   * are HTML when present, so HTML returns it as-is, Markdown converts it, and Plain
   * strips the tags.
   */
  private formatDescription(html: string | null, format?: DescriptionFormat): string | null {
    if (!html) return null;
    if (format === DescriptionFormat.HTML) return html;
    if (format === DescriptionFormat.MARKDOWN) return markdownConverter(html) ?? html;
    return htmlToPlainText(html) ?? html;
  }

  /**
   * Resolve the tenant slug. An explicit `companySlug` is used directly (a bare portal
   * URL passed as the slug is reduced to its tenant token); a `companyUrl` on a
   * `my.salesforce-sites.com` host has the tenant taken from its leading sub-domain
   * label. Returns an empty string when neither yields a tenant.
   */
  private resolveTenant(companySlug: string | undefined, companyUrl: string | undefined): string {
    if (companySlug && companySlug.trim()) {
      const slug = companySlug.trim();
      // A caller may also pass a full portal URL as the slug.
      if (/^https?:\/\//i.test(slug) || slug.includes(SAGEPEOPLE_ROOT_DOMAIN)) {
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
   * Derive the tenant token from a Sage People portal URL. The candidate-facing host is
   * `{tenant}.my.salesforce-sites.com`; the tenant is the leading sub-domain label.
   */
  private tenantFromUrl(value: string): string {
    const raw = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    try {
      const u = new URL(raw);
      const hostname = u.hostname.toLowerCase();
      if (!hostname.endsWith(SAGEPEOPLE_CAREER_HOST_SUFFIX)) {
        // Not a hosted Salesforce-Sites careers host — no derivable tenant.
        return '';
      }
      const label = hostname.slice(0, hostname.length - SAGEPEOPLE_CAREER_HOST_SUFFIX.length);
      // Guard against an empty / `www` / `portal` label (non-tenant hosts).
      if (!label || label === 'www' || label === 'portal') return '';
      return label.toLowerCase();
    } catch {
      // Malformed URL — no tenant.
    }
    return '';
  }

  /**
   * Assemble a board (open-roles list) URL for a tenant + site-path + page number. An
   * empty site-path mounts the Recruit page directly under the host root. The board keys
   * its public listing off the default `portal` label and Salesforce's `pageNumber`
   * pagination parameter.
   */
  private buildBoardUrl(tenant: string, path: string, page: number): string {
    const origin = sagePeopleCareerOrigin(tenant);
    const base = path ? `${origin}/${path}/${SAGEPEOPLE_JOB_LIST_PAGE}` : `${origin}/${SAGEPEOPLE_JOB_LIST_PAGE}`;
    const params = new URLSearchParams({ portal: SAGEPEOPLE_DEFAULT_PORTAL });
    if (page > 1) params.set('pageNumber', String(page));
    return `${base}?${params.toString()}`;
  }

  /**
   * Assemble the canonical per-role detail / apply URL. The harvested anchor href is the
   * source of truth (it already carries `vacancyNo` and the tenant's own `portal` label);
   * a relative href is resolved against the tenant origin, and a bare-page href is
   * rebuilt from the parts so the URL is always absolute and complete.
   */
  private buildJobUrl(tenant: string, vacancy: SagePeopleVacancy): string {
    const origin = sagePeopleCareerOrigin(tenant);
    const href = this.cleanText(vacancy.href);
    if (href) {
      if (/^https?:\/\//i.test(href)) return href;
      const sep = href.startsWith('/') ? '' : '/';
      return `${origin}${sep}${href}`;
    }
    // Defensive fallback — synthesise the detail URL from the parts.
    const portal = this.cleanText(vacancy.portal) ?? SAGEPEOPLE_DEFAULT_PORTAL;
    const params = new URLSearchParams({
      vacancyNo: vacancy.vacancyNo,
      portal,
    });
    return `${origin}/careers/${SAGEPEOPLE_JOB_PAGE}?${params.toString()}`;
  }

  /** De-slugify + title-case the tenant token into a display company name. */
  private deriveSlugName(tenant: string): string {
    const base = tenant && tenant.trim() ? tenant.trim() : tenant;
    return base.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /** Pull the `vacancyNo` token out of a detail href, or null when absent. */
  private extractVacancyNo(href: string): string | null {
    SAGEPEOPLE_VACANCY_NO_REGEX.lastIndex = 0;
    const match = SAGEPEOPLE_VACANCY_NO_REGEX.exec(href);
    if (!match || !match[1]) return null;
    return this.cleanText(this.decodeEntities(match[1]));
  }

  /** Pull the `portal` label out of a detail href, or null when absent. */
  private extractPortal(href: string): string | null {
    SAGEPEOPLE_PORTAL_REGEX.lastIndex = 0;
    const match = SAGEPEOPLE_PORTAL_REGEX.exec(href);
    if (!match || !match[1]) return null;
    return this.cleanText(this.decodeEntities(match[1]));
  }

  /** Read the board's "Page N of M" total page count; defaults to 1 when not present. */
  private parseTotalPages(html: string): number {
    SAGEPEOPLE_PAGINATION_REGEX.lastIndex = 0;
    const match = SAGEPEOPLE_PAGINATION_REGEX.exec(html);
    if (!match || !match[2]) return 1;
    const total = parseInt(match[2], 10);
    return Number.isFinite(total) && total > 0 ? total : 1;
  }

  /** Append only not-yet-seen roles (by `vacancyNo`) into the accumulator. */
  private collectUnique(
    source: SagePeopleVacancy[],
    target: SagePeopleVacancy[],
    seen: Set<string>,
  ): void {
    for (const vacancy of source) {
      if (seen.has(vacancy.vacancyNo)) continue;
      seen.add(vacancy.vacancyNo);
      target.push(vacancy);
    }
  }

  /**
   * Surface the role's location parts as a LocationDto, leaving location null when
   * nothing usable is present.
   */
  private extractLocation(job: SagePeopleJob): LocationDto | null {
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

  /** Detect remote roles from the title or location text. */
  private detectRemote(title: string | null, location: string | null): boolean {
    const haystacks: Array<string | null | undefined> = [title, location];
    for (const field of haystacks) {
      if (typeof field !== 'string') continue;
      if (SAGEPEOPLE_REMOTE_REGEX.test(field)) return true;
    }
    return false;
  }

  /** Strip HTML tags from an anchor's inner markup and collapse whitespace to plain text. */
  private stripTags(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null;
    const text = this.decodeEntities(value.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
    return text.length > 0 ? text : null;
  }

  /** Decode the handful of HTML entities that appear in titles / hrefs. */
  private decodeEntities(value: string): string {
    return value
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      .replace(/&nbsp;/gi, ' ');
  }

  /** Trim a string, returning null for empty / non-string values. */
  private cleanText(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null;
    const v = value.trim();
    return v.length > 0 ? v : null;
  }
}
