import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  IScraper,
  ScraperInputDto,
  JobResponseDto,
  JobPostDto,
  LocationDto,
  CompensationDto,
  Site,
  DescriptionFormat,
} from '@ever-jobs/models';
import {
  createHttpClient,
  htmlToPlainText,
  markdownConverter,
  extractEmails,
  toDateOnly,
  resolveCompensation,
} from '@ever-jobs/common';
import {
  DOVER_ROOT_DOMAIN,
  DOVER_SLUG_API_TEMPLATE,
  DOVER_CAREERS_PAGE_API_TEMPLATE,
  DOVER_JOBS_API_TEMPLATE,
  DOVER_DETAIL_API_TEMPLATE,
  DOVER_BOARD_URL_TEMPLATE,
  DOVER_CAREERS_URL_TEMPLATE,
  DOVER_BOARD_PATH_REGEX,
  DOVER_UUID_REGEX,
  DOVER_REMOTE_WORKPLACE,
  DOVER_REMOTE_REGEX,
  DOVER_DEFAULT_RESULTS,
  DOVER_HEADERS,
  doverCompensationInterval,
} from './dover.constants';
import {
  DoverCareersPage,
  DoverCompensation,
  DoverJob,
  DoverJobDetail,
  DoverJobsResponse,
  DoverListJob,
  DoverLocation,
  DoverLocationOption,
} from './dover.types';

/**
 * Dover ATS careers scraper — generic, multi-tenant.
 *
 * Dover (dover.com) is a modern recruiting-automation ATS whose candidate-facing
 * product is a no-code, hosted/embeddable careers board on `app.dover.com`. The
 * boards are client-rendered SPAs, so the adapter talks to the public REST API
 * the SPA calls (unauthenticated), in three steps:
 *
 *   1. Resolve the board slug → careers-page client id
 *      (`/api/v1/careers-page-slug/{slug}`, or `/api/v1/careers-page/{id}` when
 *      the identifier is already a careers-page UUID).
 *   2. List the tenant's open roles (`/api/v1/careers-page/{clientId}/jobs`).
 *   3. Overlay each role's rich detail
 *      (`/api/v1/inbound/application-portal-job/{jobId}`) for the body,
 *      structured compensation, posted date, and the company name.
 *
 * The caller addresses a tenant by `companySlug` (the board slug, a careers-page
 * UUID, or a company display name) or by `companyUrl` (a `/jobs/{slug}`,
 * `/apply/{Name}`, or `/{company}/careers/{uuid}` board URL). A single fetch
 * error, an unknown tenant (HTTP 4xx), or a malformed payload degrades to an
 * empty / partial result rather than throwing, so a single tenant never nukes a
 * batch run.
 */
@SourcePlugin({
  site: Site.DOVER,
  name: 'Dover',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class DoverService implements IScraper {
  private readonly logger = new Logger(DoverService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    if (!input.companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for Dover scraper');
      return new JobResponseDto([]);
    }

    const token = this.resolveToken(input.companySlug, input.companyUrl);
    if (!token) {
      this.logger.warn('Could not resolve a Dover board token from input');
      return new JobResponseDto([]);
    }

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(DOVER_HEADERS);

    const resultsWanted = input.resultsWanted ?? DOVER_DEFAULT_RESULTS;
    const jobPosts: JobPostDto[] = [];

    try {
      this.logger.log(`Resolving Dover careers page for token: ${token}`);

      // Step 1 — resolve the token to a careers-page client id.
      const page = await this.resolveCareersPage(client, token);
      if (!page?.id) {
        this.logger.warn(`Could not resolve a Dover careers page for "${token}"`);
        return new JobResponseDto([]);
      }
      const clientId = page.id;
      const slug = this.cleanText(page.slug);
      const pageName = this.cleanText(page.name);

      // Step 2 — list the tenant's open roles.
      const listings = await this.fetchJobs(client, clientId, resultsWanted);
      const seen = new Set<string>();
      const wanted = listings
        .filter((j) => j.is_sample !== true)
        .map((listing) => ({ listing, jobId: this.cleanText(listing.id) }))
        .filter((x): x is { listing: DoverListJob; jobId: string } => !!x.jobId)
        .filter((x) => !seen.has(x.jobId) && seen.add(x.jobId))
        .slice(0, resultsWanted);

      // Step 3 — overlay each role's detail and emit it.
      for (const { listing, jobId } of wanted) {
        try {
          const detail = await this.fetchDetail(client, jobId);
          const job = this.assemble(listing, detail, jobId, clientId, slug, pageName);
          const post = this.toJobPost(job, input.descriptionFormat);
          if (post) jobPosts.push(post);
        } catch (err: any) {
          this.logger.warn(`Error processing Dover job ${jobId}: ${err.message}`);
        }
      }

      this.logger.log(`Dover total: ${jobPosts.length} jobs for ${slug ?? clientId}`);
      return new JobResponseDto(jobPosts);
    } catch (err: any) {
      this.logger.error(`Dover scrape error for ${token}: ${err.message}`);
      return new JobResponseDto(jobPosts); // partial results
    }
  }

  /**
   * Resolve the addressing token to a careers-page `{ id, name, slug }`. A
   * careers-page UUID is looked up directly; otherwise we try slug variants
   * (Dover slugs are inconsistent: "Mersenne Labs" → "mersennelabs" but
   * "Somewear Labs" → "somewear-labs"). Returns null when nothing resolves.
   */
  private async resolveCareersPage(
    client: ReturnType<typeof createHttpClient>,
    token: string,
  ): Promise<DoverCareersPage | null> {
    if (DOVER_UUID_REGEX.test(token)) {
      const url = DOVER_CAREERS_PAGE_API_TEMPLATE.replace('{id}', encodeURIComponent(token));
      const page = await this.fetchCareersPage(client, url);
      if (page?.id) return page;
    }
    for (const variant of this.slugVariants(token)) {
      const url = DOVER_SLUG_API_TEMPLATE.replace('{slug}', encodeURIComponent(variant));
      const page = await this.fetchCareersPage(client, url);
      if (page?.id) return page;
    }
    return null;
  }

  /** Fetch a careers-page resolution endpoint. HTTP 4xx degrades to null. */
  private async fetchCareersPage(
    client: ReturnType<typeof createHttpClient>,
    url: string,
  ): Promise<DoverCareersPage | null> {
    try {
      const response = await client.get<DoverCareersPage>(url, { responseType: 'json' });
      const data = response.data;
      return data && typeof data === 'object' ? data : null;
    } catch (err: any) {
      const status = err?.response?.status;
      if (status && status >= 400 && status < 500) return null;
      throw err;
    }
  }

  /**
   * List a tenant's open roles by careers-page client id, following the `next`
   * cursor until `resultsWanted` is reached. An unknown id (HTTP 4xx) degrades to
   * an empty list.
   */
  private async fetchJobs(
    client: ReturnType<typeof createHttpClient>,
    clientId: string,
    resultsWanted: number,
  ): Promise<DoverListJob[]> {
    const results: DoverListJob[] = [];
    let url: string | null = DOVER_JOBS_API_TEMPLATE.replace('{id}', encodeURIComponent(clientId));
    try {
      while (url && results.length < resultsWanted) {
        const response: { data?: DoverJobsResponse } = await client.get<DoverJobsResponse>(url, {
          responseType: 'json',
        });
        const page = response.data;
        const batch = Array.isArray(page?.results) ? page!.results! : [];
        for (const job of batch) {
          if (job && typeof job === 'object') results.push(job);
        }
        url = typeof page?.next === 'string' && page.next ? page.next : null;
      }
    } catch (err: any) {
      const status = err?.response?.status;
      if (status && status >= 400 && status < 500) {
        this.logger.warn(`Dover jobs list returned HTTP ${status} for ${clientId}`);
        return results;
      }
      throw err;
    }
    return results;
  }

  /**
   * Fetch a role's detail overlay. A removed role (HTTP 4xx) degrades to null
   * without failing the batch.
   */
  private async fetchDetail(
    client: ReturnType<typeof createHttpClient>,
    jobId: string,
  ): Promise<DoverJobDetail | null> {
    const url = DOVER_DETAIL_API_TEMPLATE.replace('{id}', encodeURIComponent(jobId));
    try {
      const response = await client.get<DoverJobDetail>(url, { responseType: 'json' });
      const data = response.data;
      return data && typeof data === 'object' ? data : null;
    } catch (err: any) {
      const status = err?.response?.status;
      if (status && status >= 400 && status < 500) {
        this.logger.warn(`Dover job ${jobId} detail not found (HTTP ${status})`);
        return null;
      }
      throw err;
    }
  }

  /** Assemble a normalised DoverJob from the list job + detail overlay. */
  private assemble(
    listing: DoverListJob,
    detail: DoverJobDetail | null,
    jobId: string,
    clientId: string,
    slug: string | null,
    pageName: string | null,
  ): DoverJob {
    const workplaceType = this.cleanText(detail?.workplace_type) ?? this.cleanText(listing.workplace_type);
    const locations = detail?.locations ?? listing.locations ?? [];
    const option = this.firstLocationOption(locations);

    return {
      jobId,
      url: slug
        ? DOVER_BOARD_URL_TEMPLATE.replace('{slug}', encodeURIComponent(slug))
        : DOVER_CAREERS_URL_TEMPLATE.replace('{id}', encodeURIComponent(clientId)),
      title: this.cleanText(detail?.title) ?? this.cleanText(listing.title),
      // The company name is the careers-page / client name, never the slug.
      companyName: this.cleanText(detail?.client_name) ?? pageName,
      descriptionHtml: this.cleanText(detail?.user_provided_description),
      city: this.cleanText(option?.city),
      state: this.cleanText(option?.state),
      country: this.cleanText(option?.country),
      employmentType: this.normaliseEmploymentType(detail?.compensation?.employment_type),
      datePosted: this.parseDate(detail?.date_posted) ?? this.parseDate(detail?.created),
      isRemote: this.detectRemote(workplaceType, locations, this.cleanText(detail?.title) ?? this.cleanText(listing.title)),
      structuredCompensation: this.buildCompensation(detail?.compensation),
    };
  }

  /** Map a normalised DoverJob → JobPostDto. */
  private toJobPost(job: DoverJob, format?: DescriptionFormat): JobPostDto | null {
    if (!job.title || !job.jobId || !job.url) return null;

    const description = this.formatDescription(job.descriptionHtml, format);

    const compensation = resolveCompensation({
      structured: job.structuredCompensation,
      text: description,
    });
    const salarySource = compensation
      ? job.structuredCompensation
        ? 'structured'
        : 'description'
      : null;

    return new JobPostDto({
      id: `dover-${job.jobId}`,
      title: job.title,
      companyName: job.companyName,
      jobUrl: job.url,
      location: this.buildLocation(job),
      description,
      datePosted: job.datePosted,
      isRemote: job.isRemote,
      ...(compensation ? { compensation, salarySource } : {}),
      emails: extractEmails(description),
      site: Site.DOVER,
      atsId: job.jobId,
      atsType: 'dover',
      employmentType: job.employmentType,
      applyUrl: job.url,
    });
  }

  /**
   * Convert the job-ad body per `descriptionFormat`. The detail body is HTML; we
   * prefer it so markdown / plain conversion is consistent.
   */
  private formatDescription(html: string | null, format?: DescriptionFormat): string | null {
    if (!html) return null;
    if (format === DescriptionFormat.HTML) return html;
    if (format === DescriptionFormat.MARKDOWN) return markdownConverter(html) ?? html;
    return htmlToPlainText(html);
  }

  /**
   * Resolve the tenant addressing token from a `companyUrl` (a `/jobs/{slug}`,
   * `/apply/{Name}`, or `/{company}/careers/{uuid}` Dover board URL) or an
   * explicit `companySlug` (a bare slug, careers-page UUID, company name, or a
   * full/partial board URL). Returns an empty string when neither yields one.
   */
  private resolveToken(companySlug: string | undefined, companyUrl: string | undefined): string {
    if (companyUrl) {
      const fromUrl = this.tokenFromUrl(companyUrl);
      if (fromUrl) return fromUrl;
    }
    if (companySlug && companySlug.trim()) {
      const slug = companySlug.trim();
      if (/^https?:\/\//i.test(slug)) {
        const fromUrl = this.tokenFromUrl(slug);
        if (fromUrl) return fromUrl;
      }
      const pathMatch = DOVER_BOARD_PATH_REGEX.exec(slug.startsWith('/') ? slug : `/${slug}`);
      if (pathMatch) {
        const label = pathMatch[1] ?? pathMatch[2] ?? pathMatch[3];
        if (label) return this.decode(label);
      }
      return this.decode(slug);
    }
    return '';
  }

  /** Parse the tenant token out of a Dover board URL (any addressing form). */
  private tokenFromUrl(rawUrl: string): string {
    try {
      const u = new URL(rawUrl);
      const hostname = u.hostname.toLowerCase();
      if (hostname !== 'app.dover.com' && !hostname.endsWith(DOVER_ROOT_DOMAIN)) {
        return '';
      }
      const pathMatch = DOVER_BOARD_PATH_REGEX.exec(u.pathname);
      if (pathMatch) {
        const label = pathMatch[1] ?? pathMatch[2] ?? pathMatch[3];
        if (label) return this.decode(label);
      }
    } catch {
      // Malformed URL — fall through.
    }
    return '';
  }

  /**
   * Candidate board slugs for a token. Dover slugs derive from the company name
   * inconsistently, so we try the raw token, lowercased, alnum-stripped, and
   * hyphenated forms (e.g. "Somewear Labs" → "somewear-labs").
   */
  private slugVariants(token: string): string[] {
    const low = token.toLowerCase();
    const variants = [
      token,
      low,
      low.replace(/[^a-z0-9]+/g, ''),
      low.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''),
    ];
    return variants.filter((v, i) => v.length > 0 && variants.indexOf(v) === i);
  }

  /** Build a structured CompensationDto from the detail's compensation block. */
  private buildCompensation(comp: DoverCompensation | null | undefined): CompensationDto | null {
    if (!comp) return null;
    const min = typeof comp.lower_bound === 'number' ? comp.lower_bound : null;
    const max = typeof comp.upper_bound === 'number' ? comp.upper_bound : null;
    if (min == null && max == null) return null;
    return new CompensationDto({
      interval: doverCompensationInterval(comp.salary_range_type) ?? undefined,
      minAmount: min ?? undefined,
      maxAmount: max ?? undefined,
      currency: this.cleanText(comp.currency_code) ?? undefined,
    });
  }

  /** Surface the role's location parts as a LocationDto, or null. */
  private buildLocation(job: DoverJob): LocationDto | null {
    if (!job.city && !job.state && !job.country) {
      return job.isRemote ? new LocationDto({ city: 'Remote' }) : null;
    }
    return new LocationDto({ city: job.city, state: job.state, country: job.country });
  }

  /** The first usable structured location option from a role's locations. */
  private firstLocationOption(locations: DoverLocation[] | null | undefined): DoverLocationOption | null {
    if (!Array.isArray(locations)) return null;
    for (const loc of locations) {
      const option = loc?.location_option;
      if (option && typeof option === 'object') {
        if (option.city || option.state || option.country) return option;
      }
    }
    return null;
  }

  /**
   * Detect remote roles from the role's `workplace_type`, a `REMOTE` location
   * type, or remote text in the title.
   */
  private detectRemote(
    workplaceType: string | null,
    locations: DoverLocation[] | null | undefined,
    title: string | null,
  ): boolean {
    if (workplaceType && workplaceType.toUpperCase() === DOVER_REMOTE_WORKPLACE) return true;
    if (Array.isArray(locations)) {
      for (const loc of locations) {
        if (this.cleanText(loc?.location_type)?.toUpperCase() === DOVER_REMOTE_WORKPLACE) return true;
      }
    }
    return typeof title === 'string' && DOVER_REMOTE_REGEX.test(title);
  }

  /**
   * Normalise an employment-type value (e.g. `FULL_TIME`, `INTERNSHIP`) into a
   * readable label (`Full Time`, `Internship`).
   */
  private normaliseEmploymentType(value: string | null | undefined): string | null {
    const cleaned = this.cleanText(value);
    if (!cleaned) return null;
    return cleaned
      .replace(/[_-]+/g, ' ')
      .toLowerCase()
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /** Percent-decode a path label, tolerating malformed escapes. */
  private decode(value: string): string {
    try {
      return decodeURIComponent(value).trim();
    } catch {
      return value.trim();
    }
  }

  /** Parse a date string into a YYYY-MM-DD string. */
  private parseDate(value: string | null | undefined): string | null {
    if (value == null || value === '') return null;
    const parsed = new Date(value);
    return isNaN(parsed.getTime()) ? null : toDateOnly(value);
  }

  /** Trim a string, returning null for empty / non-string values. */
  private cleanText(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null;
    const v = value.trim();
    return v.length > 0 ? v : null;
  }
}
