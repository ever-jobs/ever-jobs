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
  SOLIDES_CAREER_HOST_SUFFIX,
  SOLIDES_ROOT_DOMAIN,
  SOLIDES_API_BASE,
  SOLIDES_VACANCY_PATH,
  SOLIDES_PAGE_SIZE,
  SOLIDES_MAX_PAGES,
  SOLIDES_DEFAULT_RESULTS,
  SOLIDES_DEFAULT_TIMEOUT_SECONDS,
  SOLIDES_HEADERS,
  SOLIDES_REMOTE_REGEX,
  solidesVacancyUrl,
} from './solides.constants';
import {
  SolidesVacancy,
  SolidesVacancyResponse,
  SolidesVacancyPage,
  SolidesNamedRef,
  SolidesJob,
} from './solides.types';

/**
 * Sólides (solides.com.br) ATS careers scraper — generic, multi-tenant.
 *
 * Sólides (solides.com.br, Brazil — "Sólides Recruta" / "Sólides Vagas") provisions
 * each customer tenant on its own sub-domain `https://{tenant}.vagas.solides.com.br/`.
 * That career site is a client-rendered Next.js SPA whose open roles are NOT in the
 * server HTML — they are fetched after hydration from the platform's public,
 * unauthenticated JSON API gateway:
 *
 *   GET https://apigw.solides.com.br/jobs/v3/home/vacancy?slug={tenant}&take={n}&page={p}
 *     → { success, errors, data: { count, currentPage, totalPages, data: [ vacancy ] } }
 *
 * The adapter calls that paginated listing endpoint directly (no headless browser, no
 * API key) and maps each vacancy. The numeric vacancy `id` is the stable ATS id and the
 * final segment of the canonical detail URL `https://{tenant}.vagas.solides.com.br/vaga/{id}`.
 *
 * The caller addresses a tenant by `companySlug` (e.g. `solides`) or by `companyUrl` (a
 * career-site URL on a `vagas.solides.com.br` host whose leading sub-domain label is the
 * tenant). An unknown tenant, one with no open roles, or an empty board degrades
 * naturally to an empty result. A fetch error, an HTTP 4xx, a DNS failure, or a
 * malformed body degrades to an empty / partial result rather than throwing, so a single
 * tenant never nukes a batch run.
 */
@SourcePlugin({
  site: Site.SOLIDES,
  name: 'Sólides',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class SolidesService implements IScraper {
  private readonly logger = new Logger(SolidesService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for Solides scraper');
      return new JobResponseDto([]);
    }

    const tenant = this.resolveTenant(companySlug, input.companyUrl);
    if (!tenant) {
      this.logger.warn('Could not resolve a Solides tenant slug from input');
      return new JobResponseDto([]);
    }

    // Cap the per-request timeout so an unresponsive Sólides gateway degrades
    // gracefully fast rather than hanging on the client's 60s default. Bound BOTH
    // keys: the no-proxy path keys off `timeout`, the proxy path off
    // `requestTimeout`. A caller may request a shorter timeout; we only cap.
    const timeoutSeconds = Math.min(
      input.requestTimeout ?? SOLIDES_DEFAULT_TIMEOUT_SECONDS,
      SOLIDES_DEFAULT_TIMEOUT_SECONDS,
    );
    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: timeoutSeconds,
      requestTimeout: timeoutSeconds,
    });
    client.setHeaders(SOLIDES_HEADERS);

    const resultsWanted = input.resultsWanted ?? SOLIDES_DEFAULT_RESULTS;
    const jobPosts: JobPostDto[] = [];

    try {
      this.logger.log(`Fetching Solides jobs for tenant: ${tenant}`);

      const vacancies = await this.fetchVacancies(client, tenant, resultsWanted);
      if (vacancies.length === 0) {
        this.logger.log(`Solides tenant "${tenant}" has no reachable open roles`);
        return new JobResponseDto([]);
      }

      const seen = new Set<string>();
      for (const vacancy of vacancies) {
        if (jobPosts.length >= resultsWanted) break;
        try {
          const post = this.processVacancy(vacancy, tenant, input.descriptionFormat, seen);
          if (post) jobPosts.push(post);
        } catch (err: any) {
          this.logger.warn(
            `Error processing Solides role ${vacancy?.id}: ${err.message}`,
          );
        }
      }

      this.logger.log(`Solides total: ${jobPosts.length} jobs for ${tenant}`);
      return new JobResponseDto(jobPosts);
    } catch (err: any) {
      this.logger.error(`Solides scrape error for ${tenant}: ${err.message}`);
      // Partial results WITH a reason: jobs.length > 0 plus a diagnostic is
      // inferred as 'partial' upstream, so a mid-scrape failure is no longer
      // indistinguishable from a complete board.
      return new JobResponseDto(jobPosts, classifyScrapeError(err));
    }
  }

  /**
   * Page through the tenant's public `/home/vacancy` listing endpoint, collecting
   * de-duplicated vacancies up to `resultsWanted` (bounded by a page cap). The response
   * carries `count` / `currentPage` / `totalPages`; the walk stops once the wanted count
   * is reached, the last page is consumed, or a page yields no new vacancies. An unknown
   * tenant or disabled board (HTTP 4xx / empty page) degrades to an empty list.
   */
  private async fetchVacancies(
    client: ReturnType<typeof createHttpClient>,
    tenant: string,
    resultsWanted: number,
  ): Promise<SolidesVacancy[]> {
    const out: SolidesVacancy[] = [];
    const seen = new Set<string>();

    for (let page = 1; page <= SOLIDES_MAX_PAGES; page++) {
      const url = this.buildVacancyUrl(tenant, page);
      const { data: pageData, hostReachable } = await this.fetchJson(client, url, tenant);
      // A transport-level failure (DNS / refused / reset / timeout) means the gateway
      // is unreachable for this tenant — no further page can succeed, so stop.
      if (!hostReachable) break;
      if (pageData == null) break;

      const rows = Array.isArray(pageData.data) ? pageData.data : [];
      let added = 0;
      for (const vacancy of rows) {
        const id = this.deriveAtsId(vacancy);
        // De-dup by ATS id across pages; skip rows without a usable id.
        if (!id || seen.has(id)) continue;
        seen.add(id);
        out.push(vacancy);
        added++;
        if (out.length >= resultsWanted) return out;
      }

      // Stop once the API signals the last page, or a page added nothing new.
      const totalPages = this.numToInt(pageData.totalPages);
      if (totalPages != null && page >= totalPages) break;
      if (added === 0) break;
    }

    return out;
  }

  /** Build a concrete paginated listing URL for a tenant + 1-based page index. */
  private buildVacancyUrl(tenant: string, page: number): string {
    const params = new URLSearchParams({
      slug: tenant,
      take: String(SOLIDES_PAGE_SIZE),
      page: String(page),
    });
    return `${SOLIDES_API_BASE}${SOLIDES_VACANCY_PATH}?${params.toString()}`;
  }

  /**
   * GET a listing URL as JSON. Returns `{ data, hostReachable }`:
   *  - `data` is the parsed vacancy page, or null when the response carried no usable
   *    page / the host answered an HTTP error status (4xx / 5xx — a real, reachable host).
   *  - `hostReachable` is false ONLY for a transport-level failure (DNS / connection
   *    refused / reset / timeout), where the gateway itself is unreachable and the caller
   *    should stop paging.
   * Never throws — every failure degrades gracefully.
   */
  private async fetchJson(
    client: ReturnType<typeof createHttpClient>,
    url: string,
    tenant: string,
  ): Promise<{ data: SolidesVacancyPage | null; hostReachable: boolean }> {
    try {
      const response = await client.get<SolidesVacancyResponse>(url);
      const body = response?.data;
      const page = body && typeof body === 'object' ? body.data ?? null : null;
      return { data: page && typeof page === 'object' ? page : null, hostReachable: true };
    } catch (err: any) {
      const status = err?.response?.status;
      if (status) {
        // The host answered an HTTP status (4xx unknown-tenant / 5xx) — it is reachable;
        // there is no further page to try for this tenant, so degrade to an empty page.
        this.logger.warn(`Solides listing returned HTTP ${status} for ${tenant}`);
        return { data: null, hostReachable: true };
      }
      // No HTTP response → transport-level failure (DNS / refused / reset / timeout):
      // the gateway is unreachable. Degrade gracefully and signal host-down.
      this.logger.warn(`Solides listing fetch failed for ${tenant}: ${err?.message ?? err}`);
      return { data: null, hostReachable: false };
    }
  }

  /** Map a parsed vacancy → JobPostDto, deduping by ATS id. */
  private processVacancy(
    vacancy: SolidesVacancy,
    tenant: string,
    format: DescriptionFormat | undefined,
    seen: Set<string>,
  ): JobPostDto | null {
    const job = this.normaliseVacancy(vacancy, tenant);
    if (!job) return null;
    if (seen.has(job.atsId)) return null;
    seen.add(job.atsId);
    return this.processJob(job, tenant, format);
  }

  /** Build a normalised SolidesJob from a parsed vacancy. */
  private normaliseVacancy(vacancy: SolidesVacancy, tenant: string): SolidesJob | null {
    const atsId = this.deriveAtsId(vacancy);
    if (!atsId) return null;

    const title = this.cleanText(vacancy.title);
    const url = solidesVacancyUrl(tenant, atsId);
    const applyUrl = this.cleanText(vacancy.redirectLink) ?? url;

    const cityName = this.cleanText(vacancy.city?.name);
    const stateName =
      this.cleanText(vacancy.state?.name) ?? this.cleanText(vacancy.state?.code);
    const countryName = this.cleanText(vacancy.address?.country?.name);
    const locationText = [cityName, stateName, countryName]
      .filter((p): p is string => !!p)
      .join(', ');

    const department = this.firstRefName(vacancy.occupationAreas);
    const employmentType = this.firstRefName(vacancy.recruitmentContractType);

    return {
      atsId,
      url,
      applyUrl,
      title,
      companyName: this.cleanText(vacancy.companyName) ?? this.deriveCompanyName(tenant),
      city: cityName,
      state: stateName,
      country: countryName,
      locationText: locationText || null,
      descriptionHtml: this.cleanText(vacancy.description),
      department,
      employmentType,
      datePosted: this.parseDate(vacancy.createdAt),
      isRemote: this.detectRemote(title, locationText, vacancy.jobType, vacancy.homeOffice),
    };
  }

  /** Map a normalised SolidesJob → JobPostDto. */
  private processJob(
    job: SolidesJob,
    tenant: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const title = job.title;
    if (!title) return null;

    const atsId = job.atsId;
    if (!atsId) return null;

    const jobUrl = job.url;
    if (!jobUrl) return null;

    const companyName = job.companyName ?? this.deriveCompanyName(tenant);
    const description = this.formatDescription(job.descriptionHtml ?? null, format);

    return new JobPostDto({
      id: `solides-${atsId}`,
      title,
      companyName,
      jobUrl,
      location: this.extractLocation(job),
      description,
      datePosted: job.datePosted ?? null,
      isRemote: job.isRemote ?? false,
      emails: extractEmails(description ?? ''),
      site: Site.SOLIDES,
      atsId,
      atsType: 'solides',
      department: job.department ?? null,
      employmentType: job.employmentType ?? null,
      applyUrl: job.applyUrl ?? jobUrl,
    });
  }

  /**
   * Convert the HTML job-ad body per `descriptionFormat`. The body is HTML, so HTML
   * returns it as-is, Markdown converts it, and Plain strips the tags.
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
   * on a `vagas.solides.com.br` host has the tenant taken from its leading sub-domain
   * label. Returns an empty string when neither yields a tenant.
   */
  private resolveTenant(companySlug: string | undefined, companyUrl: string | undefined): string {
    if (companySlug && companySlug.trim()) {
      const slug = companySlug.trim();
      // A caller may also pass a full career-site URL as the slug.
      if (/^https?:\/\//i.test(slug) || slug.includes(SOLIDES_ROOT_DOMAIN)) {
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
   * Derive the tenant token from a Sólides career-site URL. The candidate-facing host
   * is `{tenant}.vagas.solides.com.br`; the tenant is the leading sub-domain label.
   */
  private tenantFromUrl(value: string): string {
    const raw = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    try {
      const u = new URL(raw);
      const hostname = u.hostname.toLowerCase();
      if (!hostname.endsWith(SOLIDES_CAREER_HOST_SUFFIX)) {
        // Not a hosted career host — no derivable tenant.
        return '';
      }
      const label = hostname.slice(0, hostname.length - SOLIDES_CAREER_HOST_SUFFIX.length);
      // Guard against an empty / `www` label.
      if (!label || label === 'www') return '';
      return label.toLowerCase();
    } catch {
      // Malformed URL — no tenant.
    }
    return '';
  }

  /** Derive the stable ATS id from a vacancy: the numeric `id`, as trimmed text. */
  private deriveAtsId(vacancy: SolidesVacancy): string | null {
    return this.numToText(vacancy?.id);
  }

  /** Read the `name` of the first usable reference in a `{id,name}[]` list. */
  private firstRefName(refs: SolidesNamedRef[] | null | undefined): string | null {
    if (!Array.isArray(refs)) return null;
    for (const ref of refs) {
      const name = this.cleanText(ref?.name);
      if (name) return name;
    }
    return null;
  }

  /** De-slugify + title-case the tenant token into a display company name. */
  private deriveCompanyName(tenant: string): string {
    const base = tenant && tenant.trim() ? tenant.trim() : tenant;
    return base.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /**
   * Surface the role's location parts as a LocationDto, leaving location null when
   * nothing usable is present.
   */
  private extractLocation(job: SolidesJob): LocationDto | null {
    const city = job.city;
    const state = job.state;
    const country = job.country;
    if (!city && !state && !country) return null;
    return new LocationDto({ city, state, country });
  }

  /** Detect remote / home-office roles from the title, location, job-type, or flag. */
  private detectRemote(
    title: string | null,
    location: string | null,
    jobType: string | null | undefined,
    homeOffice: boolean | null | undefined,
  ): boolean {
    if (homeOffice === true) return true;
    const haystacks: Array<string | null | undefined> = [title, location, jobType];
    for (const field of haystacks) {
      if (typeof field !== 'string') continue;
      if (SOLIDES_REMOTE_REGEX.test(field)) return true;
    }
    return false;
  }

  /**
   * Parse a date value (e.g. `2026-06-01`) into a YYYY-MM-DD string. Non-absolute /
   * unparseable values yield null.
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

  /** Coerce a numeric / numeric-string field into an integer, or null when absent. */
  private numToInt(value: number | string | null | undefined): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
    if (typeof value === 'string' && value.trim()) {
      const n = Number(value);
      if (Number.isFinite(n)) return Math.trunc(n);
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
