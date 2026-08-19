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
  HIBOB_API_BASE,
  HIBOB_CAREERS_DOMAIN,
  HIBOB_ROOT_DOMAIN,
  HIBOB_JOB_ADS_SEARCH_PATH,
  HIBOB_JOB_ADS_PATH,
  HIBOB_REMOTE_REGEX,
  HIBOB_DEFAULT_RESULTS,
  HIBOB_HEADERS,
} from './hibob.constants';
import {
  HiBobJob,
  HiBobJobAd,
  HiBobJobAdEntry,
  HiBobJobAdsSearchResponse,
  HiBobJobAdDetailResponse,
} from './hibob.types';

/**
 * HiBob ("Bob", hibob.com) ATS / careers scraper — generic, multi-tenant.
 *
 * HiBob is an HR platform whose Hiring module powers each customer's candidate
 * careers page on the shared host `https://{tenant}.careers.hibob.com/jobs` (an
 * individual role lives at `/jobs/{jobId}`, its application form at
 * `/jobs/{jobId}/apply`). The careers page is a client-rendered SPA, so instead of
 * scraping HTML the adapter consumes the documented, anonymous Hiring API on
 * `api.hibob.com` that the SPA itself uses: an active-job-ads search
 * (`POST /v1/hiring/job-ads/search`, all roles promoted on the careers page) and a
 * per-role detail object (`GET /v1/hiring/job-ads/{id}`) carrying the full body and
 * metadata. The Hiring API documents that retrieving Job Ads requires no
 * permission.
 *
 * The caller addresses a tenant by `companySlug` (the careers sub-domain label,
 * e.g. `dcbyte`) or by `companyUrl` (a careers URL whose sub-domain encodes the
 * tenant slug). The job-ads search returns the tenant's active roles in one
 * response; the adapter slices to `resultsWanted`, then fetches each role's detail
 * object for the full body. A fetch error, an HTTP 4xx, or a malformed object
 * degrades to an empty / partial result rather than throwing, so a single tenant
 * never nukes a batch run.
 *
 * Surface confidence: DEFENSIVE (verified=false). The platform + tenant addressing
 * are confirmed live (real tenants `hibob-e360`, `dcbyte`) and the public Hiring
 * API endpoints are documented as anonymous, but the docs portal gates the exact
 * request/response schema, so the wire envelope is probed defensively and the
 * careers portal is used as the authoritative public URL source.
 */
@SourcePlugin({
  site: Site.HIBOB,
  name: 'HiBob',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class HiBobService implements IScraper {
  private readonly logger = new Logger(HiBobService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for HiBob scraper');
      return new JobResponseDto([]);
    }

    const tenant = this.resolveTenant(companySlug, input.companyUrl);
    if (!tenant) {
      this.logger.warn('Could not resolve a HiBob tenant slug from input');
      return new JobResponseDto([]);
    }

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(HIBOB_HEADERS);

    const resultsWanted = input.resultsWanted ?? HIBOB_DEFAULT_RESULTS;
    const seen = new Set<string>();
    const jobPosts: JobPostDto[] = [];

    try {
      this.logger.log(`Fetching HiBob jobs for tenant: ${tenant}`);

      // Fetch the tenant's active job ads (one search request returns all roles).
      const entries = await this.fetchJobAds(client, tenant, resultsWanted, seen);
      if (entries.length === 0) {
        this.logger.log(`HiBob tenant "${tenant}" has no active job ads`);
        return new JobResponseDto([]);
      }

      for (const entry of entries) {
        try {
          const post = await this.processEntry(client, entry, tenant, input.descriptionFormat);
          if (post) jobPosts.push(post);
        } catch (err: any) {
          this.logger.warn(`Error processing HiBob role: ${err.message}`);
        }
      }

      this.logger.log(`HiBob total: ${jobPosts.length} jobs for ${tenant}`);
      return new JobResponseDto(jobPosts);
    } catch (err: any) {
      this.logger.error(`HiBob scrape error for ${tenant}: ${err.message}`);
      // Partial results WITH a reason: jobs.length > 0 plus a diagnostic is
      // inferred as 'partial' upstream, so a mid-scrape failure is no longer
      // indistinguishable from a complete board.
      return new JobResponseDto(jobPosts, classifyScrapeError(err));
    }
  }

  /**
   * Fetch the tenant's active job ads via `POST /v1/hiring/job-ads/search` (empty
   * filters → all active ads), accumulating up to `resultsWanted` deduped roles. An
   * unknown tenant / missing board returns an empty list (HTTP 200 empty or 4xx); an
   * HTTP 4xx degrades to an empty list rather than throwing.
   */
  private async fetchJobAds(
    client: ReturnType<typeof createHttpClient>,
    tenant: string,
    resultsWanted: number,
    seen: Set<string>,
  ): Promise<HiBobJobAdEntry[]> {
    const entries: HiBobJobAdEntry[] = [];
    const url = `${HIBOB_API_BASE}${HIBOB_JOB_ADS_SEARCH_PATH}`;

    // The careers SPA identifies its tenant via the request host / a company key;
    // the search body simply asks for all active ads (empty filters + fields).
    const payload = {
      companySlug: tenant,
      company: tenant,
      filters: [] as unknown[],
      fields: [] as unknown[],
    };

    let body: HiBobJobAdsSearchResponse | null;
    try {
      const response = await client.post<HiBobJobAdsSearchResponse>(url, payload, {
        headers: { ...HIBOB_HEADERS, 'X-Company': tenant },
      });
      body = this.asObject<HiBobJobAdsSearchResponse>(response.data);
    } catch (err: any) {
      const status = err?.response?.status;
      if (status && status >= 400 && status < 500) {
        this.logger.warn(`HiBob job ads not found (HTTP ${status}) for ${tenant}`);
        return entries;
      }
      throw err;
    }

    const results = this.extractEntries(body);
    for (const entry of results) {
      const ad = this.adOf(entry);
      const id = this.cleanText(String(ad?.id ?? entry?.id ?? ''));
      if (!id || seen.has(id)) continue;
      seen.add(id);
      entries.push(entry);
      if (entries.length >= resultsWanted) break;
    }

    return entries;
  }

  /** Pull the active-ad array out of the search envelope, tolerating key drift. */
  private extractEntries(body: HiBobJobAdsSearchResponse | null): HiBobJobAdEntry[] {
    if (!body) return [];
    if (Array.isArray(body.jobAds)) return body.jobAds as HiBobJobAdEntry[];
    if (Array.isArray(body.results)) return body.results as HiBobJobAdEntry[];
    if (Array.isArray(body.items)) return body.items as HiBobJobAdEntry[];
    return [];
  }

  /** Fetch + parse a single role's detail object, then map it to a JobPostDto. */
  private async processEntry(
    client: ReturnType<typeof createHttpClient>,
    entry: HiBobJobAdEntry,
    tenant: string,
    format: DescriptionFormat | undefined,
  ): Promise<JobPostDto | null> {
    const listAd = this.adOf(entry);
    const jobId = this.cleanText(String(listAd?.id ?? entry?.id ?? ''));
    if (!jobId) return null;

    let detail: HiBobJobAd | null = null;
    const url = `${HIBOB_API_BASE}${HIBOB_JOB_ADS_PATH}/${encodeURIComponent(jobId)}`;
    try {
      const response = await client.get<HiBobJobAdDetailResponse>(url, {
        headers: { ...HIBOB_HEADERS, 'X-Company': tenant },
      });
      const detailBody = this.asObject<HiBobJobAdDetailResponse>(response.data);
      // The detail may be nested under `jobAd` or returned at the top level.
      detail =
        this.asObject<HiBobJobAd>(detailBody?.jobAd) ??
        this.asObject<HiBobJobAd>(response.data as unknown);
    } catch (err: any) {
      const status = err?.response?.status;
      if (status && status >= 400 && status < 500) {
        // A closed / removed role 404s; skip its detail but still map the list ad.
        this.logger.warn(`HiBob role ${jobId} detail not found (HTTP ${status})`);
        detail = null;
      } else {
        throw err;
      }
    }

    const job = this.mergeJob(listAd, detail, tenant, jobId);
    return this.processJob(job, tenant, format);
  }

  /** Merge a list ad and its (optional) detail ad into a normalised HiBobJob. */
  private mergeJob(
    listAd: HiBobJobAd | null,
    detail: HiBobJobAd | null,
    tenant: string,
    jobId: string,
  ): HiBobJob {
    const title =
      this.cleanText(detail?.title) ??
      this.cleanText(listAd?.title) ??
      this.cleanText(detail?.name) ??
      this.cleanText(listAd?.name);

    const location = this.cleanText(detail?.location) ?? this.cleanText(listAd?.location);
    const city = this.cleanText(detail?.city) ?? this.cleanText(listAd?.city);
    const state = this.cleanText(detail?.state) ?? this.cleanText(listAd?.state);
    const country = this.cleanText(detail?.country) ?? this.cleanText(listAd?.country);

    const department =
      this.cleanText(detail?.department) ??
      this.cleanText(listAd?.department) ??
      this.cleanText(detail?.team) ??
      this.cleanText(listAd?.team);

    const employmentType =
      this.cleanText(detail?.employmentType) ??
      this.cleanText(listAd?.employmentType) ??
      this.cleanText(detail?.jobType) ??
      this.cleanText(listAd?.jobType);

    const workplaceType =
      this.cleanText(detail?.workplaceType) ?? this.cleanText(listAd?.workplaceType);

    // The API may carry an absolute detail / apply URL; fall back to the canonical
    // careers-portal shape derived from the tenant + jobId.
    const apiUrl = this.cleanText(detail?.url) ?? this.cleanText(listAd?.url);
    const apiApplyUrl = this.cleanText(detail?.applyUrl) ?? this.cleanText(listAd?.applyUrl);

    // Derive a structured city from the free-text location when no explicit city.
    const city2 = city ?? (location && !this.isRemoteToken(location) ? location : null);

    return {
      jobId,
      url: apiUrl ?? this.buildJobUrl(tenant, jobId),
      applyUrl: apiApplyUrl ?? this.buildApplyUrl(tenant, jobId),
      title,
      companyName: this.deriveCompanyName(tenant),
      descriptionHtml: this.cleanText(detail?.description) ?? this.cleanText(listAd?.description),
      city: city2,
      state,
      country,
      department,
      employmentType: this.normaliseEmploymentType(employmentType),
      datePosted: this.parseDate(detail?.createdAt ?? listAd?.createdAt ?? detail?.publishedAt ?? listAd?.publishedAt),
      isRemote: this.detectRemote(detail ?? listAd, title, location, workplaceType),
    };
  }

  /** Map a normalised HiBobJob → JobPostDto. */
  private processJob(
    job: HiBobJob,
    tenant: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const title = job.title;
    if (!title) return null;

    const atsId = String(job.jobId ?? '');
    if (!atsId) return null;

    const jobUrl = job.url;
    if (!jobUrl) return null;

    const companyName = job.companyName ?? this.deriveCompanyName(tenant);
    const description = this.formatDescription(job.descriptionHtml ?? null, format);

    return new JobPostDto({
      id: `hibob-${atsId}`,
      title,
      companyName,
      jobUrl,
      location: this.extractLocation(job),
      description,
      datePosted: job.datePosted ?? null,
      isRemote: job.isRemote ?? false,
      emails: extractEmails(description ?? ''),
      site: Site.HIBOB,
      atsId,
      atsType: 'hibob',
      department: this.cleanText(job.department),
      employmentType: this.cleanText(job.employmentType),
      applyUrl: job.applyUrl ?? jobUrl,
    });
  }

  /**
   * Convert the job-ad body per `descriptionFormat`. The job ad's `description` is
   * an HTML body, so markdown / plain conversion is consistent.
   */
  private formatDescription(html: string | null, format?: DescriptionFormat): string | null {
    if (!html) return null;
    if (format === DescriptionFormat.HTML) return html;
    if (format === DescriptionFormat.MARKDOWN) return markdownConverter(html) ?? html;
    return htmlToPlainText(html);
  }

  /**
   * Resolve the tenant slug. An explicit `companySlug` is used directly (a bare
   * careers URL passed as the slug is reduced to its tenant token); a `companyUrl`
   * on a `hibob.com` host has the tenant taken from its leading sub-domain label.
   * Returns an empty string when neither yields a tenant.
   */
  private resolveTenant(companySlug: string | undefined, companyUrl: string | undefined): string {
    if (companySlug && companySlug.trim()) {
      const slug = companySlug.trim();
      // A caller may also pass a full careers URL as the slug.
      if (/^https?:\/\//i.test(slug) || slug.includes(HIBOB_ROOT_DOMAIN)) {
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
   * Derive the tenant token from a HiBob careers URL. The candidate-facing form is
   * `https://{tenant}.careers.hibob.com/jobs`; the tenant is the leading sub-domain
   * label (the label before `careers.hibob.com`).
   */
  private tenantFromUrl(value: string): string {
    const raw = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    try {
      const u = new URL(raw);
      const hostname = u.hostname.toLowerCase();
      if (!hostname.endsWith(HIBOB_ROOT_DOMAIN)) return '';
      // `{tenant}.careers.hibob.com` → leading label is the tenant.
      if (hostname.endsWith(`.${HIBOB_CAREERS_DOMAIN}`)) {
        const label = hostname.slice(0, hostname.length - `.${HIBOB_CAREERS_DOMAIN}`.length);
        const first = label.split('.')[0];
        if (first && first !== 'www') return first;
      }
      // Fall back to the leading sub-domain label of any `hibob.com` host.
      const parts = hostname.split('.');
      const label = parts[0];
      if (label && label !== 'www' && label !== 'careers' && label !== 'api' && label !== 'app') {
        return label;
      }
    } catch {
      // Malformed URL — no tenant.
    }
    return '';
  }

  /** Build the canonical public detail URL for a role. */
  private buildJobUrl(tenant: string, jobId: string): string {
    return `https://${encodeURIComponent(tenant)}.${HIBOB_CAREERS_DOMAIN}/jobs/${encodeURIComponent(
      jobId,
    )}`;
  }

  /** Build the canonical public apply URL for a role. */
  private buildApplyUrl(tenant: string, jobId: string): string {
    return `${this.buildJobUrl(tenant, jobId)}/apply`;
  }

  /** De-slugify + title-case the tenant token into a display company name. */
  private deriveCompanyName(tenant: string): string {
    const base = tenant && tenant.trim() ? tenant.trim() : tenant;
    return base.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /**
   * Surface the role's location parts (city / state / country) as a LocationDto,
   * leaving location null when nothing usable is present.
   */
  private extractLocation(job: HiBobJob): LocationDto | null {
    const city = job.city;
    const state = job.state;
    const country = job.country;
    if (!city && !state && !country) return null;
    return new LocationDto({ city, state, country });
  }

  /** Detect remote roles from the explicit flag, `workplaceType`, the title, or the location. */
  private detectRemote(
    ad: HiBobJobAd | null,
    title: string | null,
    location: string | null,
    workplaceType: string | null,
  ): boolean {
    if (ad && ad.remote === true) return true;
    if (workplaceType && /remote/i.test(workplaceType)) return true;
    const haystacks: Array<string | null | undefined> = [title, location];
    for (const field of haystacks) {
      if (typeof field !== 'string') continue;
      if (HIBOB_REMOTE_REGEX.test(field)) return true;
    }
    return false;
  }

  /** True when a location token is a bare "Remote" marker rather than a real place. */
  private isRemoteToken(value: string): boolean {
    return /^remote$/i.test(value.trim());
  }

  /**
   * Normalise a HiBob employment-type token (e.g. `Full-time`, `PART_TIME`,
   * `CONTRACT`, `INTERNSHIP`) into a readable label (`Full Time`, `Part Time`, …).
   * Free-text values are passed through trimmed + title-cased.
   */
  private normaliseEmploymentType(value: string | null | undefined): string | null {
    const cleaned = this.cleanText(value);
    if (!cleaned) return null;
    const spaced = cleaned
      .replace(/[_-]+/g, ' ')
      .replace(/\bfulltime\b/i, 'full time')
      .replace(/\bparttime\b/i, 'part time');
    return spaced.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /** Parse a date string into a YYYY-MM-DD string. */
  private parseDate(value: string | null | undefined): string | null {
    if (value == null || value === '') return null;
    try {
      const parsed = new Date(value);
      if (!isNaN(parsed.getTime())) return toDateOnly(value);
    } catch {
      // ignore
    }
    return null;
  }

  /** Pull the nested `jobAd` object out of a search entry, tolerating flat entries. */
  private adOf(entry: HiBobJobAdEntry | null | undefined): HiBobJobAd | null {
    if (!entry || typeof entry !== 'object') return null;
    const nested = this.asObject<HiBobJobAd>(entry.jobAd);
    if (nested) return nested;
    // Some tenants return the ad fields flat on the entry itself.
    return this.asObject<HiBobJobAd>(entry as unknown);
  }

  /** Narrow an arbitrary parsed response body to a plain object, or null. */
  private asObject<T>(value: unknown): T | null {
    return value && typeof value === 'object' ? (value as T) : null;
  }

  /** Trim a string, returning null for empty / non-string values. */
  private cleanText(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null;
    const v = value.trim();
    return v.length > 0 ? v : null;
  }
}
