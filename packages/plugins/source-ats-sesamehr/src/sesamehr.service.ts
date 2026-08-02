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
  SESAMEHR_ROOT_DOMAIN,
  SESAMEHR_PORTAL_HOST,
  SESAMEHR_REGION_FINDER_ORIGIN,
  SESAMEHR_REGION_FINDER_PATH,
  SESAMEHR_DEFAULT_REGION,
  SESAMEHR_PAGE_SIZE,
  SESAMEHR_DEFAULT_RESULTS,
  SESAMEHR_MAX_PAGES,
  SESAMEHR_DEFAULT_TIMEOUT_SECONDS,
  SESAMEHR_HEADERS,
  SESAMEHR_REGION_FINDER_HEADERS,
  SESAMEHR_REMOTE_MODALITY,
  SESAMEHR_REMOTE_REGEX,
  sesamehrBackendOrigin,
  sesamehrVacanciesPath,
  sesamehrJobUrl,
  sesamehrApplyUrl,
} from './sesamehr.constants';
import {
  SesameHrJob,
  SesameHrRegionResponse,
  SesameHrVacancy,
  SesameHrVacanciesResponse,
} from './sesamehr.types';

/**
 * Sesame HR ATS careers scraper — generic, multi-tenant.
 *
 * Sesame HR (sesamehr.com / sesametime.com — a Spain/LATAM-focused all-in-one HR suite with
 * a built-in recruiting / ATS module) gives every customer tenant a branded, public,
 * unauthenticated candidate-facing career portal on its shared web app at
 * `https://app.sesametime.com/jobs/{company}/all`. That portal is a client-rendered SPA; the
 * role data it shows is loaded from a **public, anonymous JSON API** on a region-specific
 * backend host. The adapter calls that JSON API directly — rather than driving a headless
 * browser — in two steps:
 *
 *  1. Region detection (anonymous): `GET login.sesametime.com/private/login-finder/v1/company/{company}`
 *     → `{ data: { region } }`, mapping the region (e.g. `EU1`) to the backend host
 *     `back-{region}.sesametime.com`. Defaults to `back-eu1` when the finder is unreachable.
 *  2. Public vacancies feed (anonymous):
 *     `GET https://back-{region}.sesametime.com/api/v3/companies/{company}/public-vacancies?page={n}`
 *     → `{ data, meta }` whose `data[]` array holds the tenant's open roles (no bearer
 *     token). The adapter drains pages via `meta.lastPage` and maps each role.
 *
 * Each role's UUID `id` is the stable ATS id, and its canonical public detail / apply URL is
 * synthesised as `https://app.sesametime.com/jobs/{company}/{id}` (and `…/apply`).
 *
 * The caller addresses a tenant by `companySlug` (the company path segment, e.g. `Sesame`)
 * or by `companyUrl` (a portal URL whose path encodes the company segment). NOTE: the
 * company segment is case-sensitive on the API, so the adapter preserves the caller's
 * casing. An unknown tenant, one with no open public roles, or a disabled portal degrades
 * naturally to an empty result. A fetch error, an HTTP 4xx/5xx, a DNS failure, or a
 * malformed body degrades to an empty / partial result rather than throwing, so a single
 * tenant never nukes a batch run.
 */
@SourcePlugin({
  site: Site.SESAMEHR,
  name: 'Sesame HR',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class SesameHrService implements IScraper {
  private readonly logger = new Logger(SesameHrService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for Sesame HR scraper');
      return new JobResponseDto([]);
    }

    const company = this.resolveCompany(companySlug, input.companyUrl);
    if (!company) {
      this.logger.warn('Could not resolve a Sesame HR company segment from input');
      return new JobResponseDto([]);
    }

    // Cap the per-request timeout so an unresponsive Sesame backend host degrades
    // gracefully fast rather than hanging on the client's 60s default. Bound BOTH
    // keys: the no-proxy path keys off `timeout`, the proxy path off `requestTimeout`.
    // A caller may request a shorter timeout; we only cap.
    const timeoutSeconds = Math.min(
      input.requestTimeout ?? SESAMEHR_DEFAULT_TIMEOUT_SECONDS,
      SESAMEHR_DEFAULT_TIMEOUT_SECONDS,
    );
    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: timeoutSeconds,
      requestTimeout: timeoutSeconds,
    });
    client.setHeaders(SESAMEHR_HEADERS);

    const resultsWanted = input.resultsWanted ?? SESAMEHR_DEFAULT_RESULTS;
    const jobPosts: JobPostDto[] = [];

    try {
      this.logger.log(`Fetching Sesame HR jobs for company: ${company}`);

      // Resolve the regional backend host (anonymous). Falls back to the default region
      // when the finder is unreachable / omits the region — never throws.
      const region = await this.resolveRegion(client, company);
      const backendOrigin = sesamehrBackendOrigin(region);

      const companyName = this.deriveSlugName(company);
      const seen = new Set<string>();

      // Drain the paginated public feed up to the page cap or until we've collected
      // `resultsWanted` roles. A transport-level failure (host unreachable) aborts the
      // sweep; an HTTP error / malformed page degrades to an empty / partial result.
      for (let page = 1; page <= SESAMEHR_MAX_PAGES; page++) {
        if (jobPosts.length >= resultsWanted) break;

        const result = await this.fetchPage(client, backendOrigin, company, page);
        // hostReachable === false → DNS / refused / reset / timeout: no further page can
        // succeed, so stop probing rather than burning a timeout per page.
        if (!result.hostReachable) break;
        const body = result.data;
        if (!body) break; // HTTP error / unparseable body → stop draining

        const items = Array.isArray(body.data) ? body.data : [];
        for (const item of items) {
          if (jobPosts.length >= resultsWanted) break;
          try {
            const post = this.processItem(
              item,
              company,
              companyName,
              input.descriptionFormat,
              seen,
            );
            if (post) jobPosts.push(post);
          } catch (err: any) {
            this.logger.warn(`Error processing Sesame HR role ${item?.id}: ${err.message}`);
          }
        }

        // Stop when the feed reports no further page (or omits the flag — single page).
        const meta = body.meta;
        const current = typeof meta?.currentPage === 'number' ? meta.currentPage : page;
        const last = typeof meta?.lastPage === 'number' ? meta.lastPage : current;
        if (current >= last) break;
      }

      this.logger.log(`Sesame HR total: ${jobPosts.length} jobs for ${company}`);
      return new JobResponseDto(jobPosts);
    } catch (err: any) {
      this.logger.error(`Sesame HR scrape error for ${company}: ${err.message}`);
      return new JobResponseDto(jobPosts); // partial results
    }
  }

  /**
   * Resolve the regional backend token for a company via the public, anonymous company
   * finder. Returns a lower-cased region token (e.g. `eu1`). Any failure — unreachable
   * finder, HTTP error, missing region — degrades to the default region; never throws.
   */
  private async resolveRegion(
    client: ReturnType<typeof createHttpClient>,
    company: string,
  ): Promise<string> {
    const url = `${SESAMEHR_REGION_FINDER_ORIGIN}/${SESAMEHR_REGION_FINDER_PATH}/${encodeURIComponent(
      company,
    )}`;
    try {
      const response = await client.get<SesameHrRegionResponse | string>(url, {
        headers: SESAMEHR_REGION_FINDER_HEADERS,
      });
      const parsed = this.coerceRegion(response.data);
      const region = this.cleanText(parsed?.data?.region);
      if (region) return region.toLowerCase();
      this.logger.warn(`Sesame HR region finder omitted a region for ${company}; using default`);
    } catch (err: any) {
      this.logger.warn(
        `Sesame HR region finder failed for ${company}: ${err?.message ?? err}; using default`,
      );
    }
    return SESAMEHR_DEFAULT_REGION;
  }

  /**
   * GET one page of the tenant's public vacancies feed as JSON. Returns
   * `{ data, hostReachable }`:
   *  - `data` is the parsed `{ data, meta }` envelope, or null when the response carried no
   *    usable JSON / the host answered an HTTP error status (4xx / 5xx — a real, reachable
   *    host).
   *  - `hostReachable` is false ONLY for a transport-level failure (DNS / connection refused
   *    / reset / timeout), where the backend host itself is unreachable and the caller
   *    should stop draining further pages.
   * Never throws — every failure degrades gracefully.
   */
  private async fetchPage(
    client: ReturnType<typeof createHttpClient>,
    backendOrigin: string,
    company: string,
    page: number,
  ): Promise<{ data: SesameHrVacanciesResponse | null; hostReachable: boolean }> {
    const url = this.buildFeedUrl(backendOrigin, company, page);
    try {
      const response = await client.get<SesameHrVacanciesResponse | string>(url);
      const parsed = this.coerceBody(response.data);
      return { data: parsed, hostReachable: true };
    } catch (err: any) {
      const status = err?.response?.status;
      if (status) {
        // The host answered an HTTP status (4xx / 5xx) — it is reachable, but there is
        // nothing more to drain.
        this.logger.warn(`Sesame HR feed returned HTTP ${status} for ${company}`);
        return { data: null, hostReachable: true };
      }
      // No HTTP response → transport-level failure (DNS / refused / reset / timeout): the
      // backend host is unreachable. Degrade gracefully and signal host-down.
      this.logger.warn(`Sesame HR feed fetch failed for ${company}: ${err?.message ?? err}`);
      return { data: null, hostReachable: false };
    }
  }

  /**
   * Coerce an axios response body into a parsed feed envelope. The client usually parses the
   * JSON for us (object body); if a tenant serves the feed as a text/plain string we parse
   * it ourselves. A non-object / unparseable body yields null (degrade to no roles).
   */
  private coerceBody(
    data: SesameHrVacanciesResponse | string | unknown,
  ): SesameHrVacanciesResponse | null {
    const parsed = this.coerceJson(data);
    return parsed ? (parsed as SesameHrVacanciesResponse) : null;
  }

  /** Coerce an axios response body into the parsed region-finder envelope. */
  private coerceRegion(
    data: SesameHrRegionResponse | string | unknown,
  ): SesameHrRegionResponse | null {
    const parsed = this.coerceJson(data);
    return parsed ? (parsed as SesameHrRegionResponse) : null;
  }

  /** Shared JSON coercion: object as-is, string parsed, anything else → null. */
  private coerceJson(data: unknown): Record<string, unknown> | null {
    if (data && typeof data === 'object') return data as Record<string, unknown>;
    if (typeof data === 'string') {
      const trimmed = data.trim();
      if (!trimmed) return null;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
      } catch (err: any) {
        this.logger.warn(`Sesame HR JSON parse failed: ${err?.message ?? err}`);
      }
    }
    return null;
  }

  /** Map a parsed role → JobPostDto, deduping by ATS id. */
  private processItem(
    item: SesameHrVacancy,
    company: string,
    companyName: string,
    format: DescriptionFormat | undefined,
    seen: Set<string>,
  ): JobPostDto | null {
    const job = this.normaliseItem(item, company, companyName);
    if (!job) return null;
    if (seen.has(job.atsId)) return null;
    seen.add(job.atsId);
    return this.processJob(job, company, format);
  }

  /** Build a normalised SesameHrJob from a parsed role. */
  private normaliseItem(
    item: SesameHrVacancy,
    company: string,
    companyName: string,
  ): SesameHrJob | null {
    const atsId = this.cleanText(item.id);
    if (!atsId) return null;

    const city = this.cleanText(item.addressCity);
    const state = this.cleanText(item.addressState);
    const country = this.cleanText(item.addressCountry);
    const locationText = this.joinLocation(city, state, country);
    const department = this.cleanText(item.category?.name);
    const title = this.cleanText(item.name);
    // Prefer the human-readable schedule-type label; fall back to the contract-type token.
    const employmentType =
      this.cleanText(item.scheduleType?.name) ?? this.humanizeToken(item.contractType);

    return {
      atsId,
      url: sesamehrJobUrl(company, atsId),
      applyUrl: sesamehrApplyUrl(company, atsId),
      title,
      companyName: companyName || this.deriveSlugName(company),
      city,
      state,
      country,
      locationText,
      descriptionHtml: this.cleanText(item.description),
      department,
      employmentType,
      datePosted: this.parseDate(item.openedAt) ?? this.parseDate(item.createdAt),
      isRemote: this.detectRemote(item, title, locationText, department),
    };
  }

  /** Map a normalised SesameHrJob → JobPostDto. */
  private processJob(
    job: SesameHrJob,
    company: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const title = job.title;
    if (!title) return null;

    const atsId = job.atsId;
    if (!atsId) return null;

    const jobUrl = job.url;
    if (!jobUrl) return null;

    const companyName = job.companyName ?? this.deriveSlugName(company);
    const description = this.formatDescription(job.descriptionHtml ?? null, format);

    return new JobPostDto({
      id: `sesamehr-${atsId}`,
      title,
      companyName,
      jobUrl,
      location: this.extractLocation(job),
      description,
      datePosted: job.datePosted ?? null,
      isRemote: job.isRemote ?? false,
      emails: extractEmails(description ?? ''),
      site: Site.SESAMEHR,
      atsId,
      atsType: 'sesamehr',
      department: job.department ?? null,
      employmentType: job.employmentType ?? null,
      applyUrl: job.applyUrl ?? jobUrl,
    });
  }

  /**
   * Convert the role description body per `descriptionFormat`. Sesame exposes the body as
   * HTML, so HTML returns it as-is, Markdown converts it, and Plain strips the tags.
   */
  private formatDescription(html: string | null, format?: DescriptionFormat): string | null {
    if (!html) return null;
    if (format === DescriptionFormat.HTML) return html;
    if (format === DescriptionFormat.MARKDOWN) return markdownConverter(html) ?? html;
    return htmlToPlainText(html) ?? html;
  }

  /**
   * Resolve the company segment. An explicit `companySlug` is used directly (a portal URL
   * passed as the slug is reduced to its company segment); a `companyUrl` on a
   * `sesametime.com` portal host has the company taken from its `/jobs/{company}/…` path.
   * Returns an empty string when neither yields a company. Casing is preserved — the feed's
   * company segment is case-sensitive.
   */
  private resolveCompany(
    companySlug: string | undefined,
    companyUrl: string | undefined,
  ): string {
    if (companySlug && companySlug.trim()) {
      const slug = companySlug.trim();
      // A caller may also pass a full portal URL as the slug.
      if (/^https?:\/\//i.test(slug) || slug.includes(SESAMEHR_ROOT_DOMAIN)) {
        const fromUrl = this.companyFromUrl(slug);
        if (fromUrl) return fromUrl;
      }
      return slug;
    }
    if (companyUrl) {
      const fromUrl = this.companyFromUrl(companyUrl);
      if (fromUrl) return fromUrl;
    }
    return '';
  }

  /**
   * Derive the company segment from a Sesame portal URL. The candidate-facing portal path is
   * `/jobs/{company}/…`; the company is the segment after `/jobs/`.
   */
  private companyFromUrl(value: string): string {
    const raw = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    try {
      const u = new URL(raw);
      const hostname = u.hostname.toLowerCase();
      // Only derive from a Sesame portal host.
      if (hostname !== SESAMEHR_PORTAL_HOST && !hostname.endsWith(`.${SESAMEHR_ROOT_DOMAIN}`)) {
        return '';
      }
      const segments = u.pathname.split('/').filter((s) => s.length > 0);
      const jobsIdx = segments.findIndex((s) => s.toLowerCase() === 'jobs');
      if (jobsIdx >= 0 && segments.length > jobsIdx + 1) {
        const company = segments[jobsIdx + 1];
        // Guard against a trailing `all` / route keyword as the company.
        if (company && company.toLowerCase() !== 'all') {
          return decodeURIComponent(company);
        }
      }
    } catch {
      // Malformed URL — no company.
    }
    return '';
  }

  /** Assemble a tenant's public vacancies-feed URL for a given page. */
  private buildFeedUrl(backendOrigin: string, company: string, page: number): string {
    const params = new URLSearchParams({ page: String(page) });
    return `${backendOrigin}/${sesamehrVacanciesPath(company)}?${params.toString()}`;
  }

  /** De-slugify + title-case the company token into a display company name. */
  private deriveSlugName(company: string): string {
    const base = company && company.trim() ? company.trim() : company;
    return base.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /** Humanize a snake_case enum token (e.g. `full_time` → `Full Time`). */
  private humanizeToken(value: string | null | undefined): string | null {
    const cleaned = this.cleanText(value);
    if (!cleaned) return null;
    return cleaned.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /**
   * Surface the role's location parts as a LocationDto, leaving location null when nothing
   * usable is present.
   */
  private extractLocation(job: SesameHrJob): LocationDto | null {
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
   * Detect remote roles from the structured `modality` token, then from the title, location,
   * or department text.
   */
  private detectRemote(
    item: SesameHrVacancy,
    title: string | null,
    location: string | null,
    department: string | null | undefined,
  ): boolean {
    const modality = this.cleanText(item.modality);
    if (modality && modality.toLowerCase().includes(SESAMEHR_REMOTE_MODALITY)) {
      return true;
    }
    const haystacks: Array<string | null | undefined> = [title, location, department];
    for (const field of haystacks) {
      if (typeof field !== 'string') continue;
      if (SESAMEHR_REMOTE_REGEX.test(field)) return true;
    }
    return false;
  }

  /**
   * Parse a timestamp value into a YYYY-MM-DD string. Sesame emits `YYYY-MM-DD HH:mm:ss`
   * (space-separated); normalise to ISO before parsing. Unparseable values yield null.
   */
  private parseDate(value: string | null | undefined): string | null {
    const cleaned = this.cleanText(value);
    if (!cleaned) return null;
    // Normalise a space-separated `YYYY-MM-DD HH:mm:ss` into ISO `YYYY-MM-DDTHH:mm:ss`.
    const iso = /^\d{4}-\d{2}-\d{2}\s\d{2}:\d{2}:\d{2}$/.test(cleaned)
      ? cleaned.replace(' ', 'T')
      : cleaned;
    try {
      const parsed = new Date(iso);
      if (!isNaN(parsed.getTime())) return toDateOnly(iso);
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
