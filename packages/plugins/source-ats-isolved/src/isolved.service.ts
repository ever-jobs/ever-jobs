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
  CompensationInterval,
  getCompensationInterval,
} from '@ever-jobs/models';
import {
  createHttpClient,
  htmlToPlainText,
  markdownConverter,
  extractEmails,
  toDateOnly,
} from '@ever-jobs/common';
import {
  ISOLVED_CAREER_HOST_SUFFIX,
  ISOLVED_ROOT_DOMAIN,
  ISOLVED_BOARD_PATH,
  ISOLVED_CORE_JOBS_PATH,
  ISOLVED_DEFAULT_RESULTS,
  ISOLVED_MAX_DETAIL_FETCHES,
  ISOLVED_DETAIL_CONCURRENCY,
  ISOLVED_DEFAULT_TIMEOUT_SECONDS,
  ISOLVED_HEADERS,
  ISOLVED_DOMAIN_ID_REGEX,
  ISOLVED_DOMAIN_TITLE_REGEX,
  ISOLVED_GET_PARAMS,
  ISOLVED_LD_JSON_REGEX,
  ISOLVED_REMOTE_REGEX,
  ISOLVED_WORKPLACE_REMOTE_REGEX,
  ISO3_TO_ISO2,
  isolvedCareerOrigin,
  isolvedJobDetailUrl,
} from './isolved.constants';
import {
  IsolvedApiJob,
  IsolvedBoardMeta,
  IsolvedDetailData,
  IsolvedJobPosting,
} from './isolved.types';

/**
 * isolved Hire ATS careers scraper — generic, multi-tenant.
 *
 * Uses the board's own JSON API for structured fields (department, compensation,
 * workplaceType) and fans out to detail pages for the full description body.
 */
@SourcePlugin({
  site: Site.ISOLVED,
  name: 'isolved Hire',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class IsolvedService implements IScraper {
  private readonly logger = new Logger(IsolvedService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    if (!input.companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for isolved Hire scraper');
      return new JobResponseDto([]);
    }

    const tenant = this.resolveTenant(input.companySlug, input.companyUrl);
    if (!tenant) {
      this.logger.warn('Could not resolve an isolved Hire tenant slug from input');
      return new JobResponseDto([]);
    }

    const timeoutSeconds = Math.min(
      input.requestTimeout ?? ISOLVED_DEFAULT_TIMEOUT_SECONDS,
      ISOLVED_DEFAULT_TIMEOUT_SECONDS,
    );
    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: timeoutSeconds,
      requestTimeout: timeoutSeconds,
    });
    client.setHeaders(ISOLVED_HEADERS);

    const resultsWanted = input.resultsWanted ?? ISOLVED_DEFAULT_RESULTS;

    try {
      this.logger.log(`Fetching isolved Hire jobs for tenant: ${tenant}`);

      const meta = await this.fetchBoardMeta(client, tenant);
      if (!meta) {
        this.logger.log(`isolved Hire: could not extract domainId for tenant "${tenant}"`);
        return new JobResponseDto([]);
      }

      const apiJobs = await this.fetchCoreJobs(client, tenant, meta.domainId);
      if (apiJobs.length === 0) {
        this.logger.log(`isolved Hire tenant "${tenant}" has no open roles`);
        return new JobResponseDto([]);
      }

      const wanted = Math.min(resultsWanted, ISOLVED_MAX_DETAIL_FETCHES);
      const selected = apiJobs.slice(0, wanted);

      const detailMap = await this.fetchDetailDescriptions(client, tenant, selected);

      const companyName = meta.companyName ?? this.deriveCompanyName(tenant);
      const jobPosts: JobPostDto[] = [];

      for (const apiJob of selected) {
        if (jobPosts.length >= resultsWanted) break;
        try {
          const detail = detailMap.get(String(apiJob.id)) ?? null;
          const post = this.processApiJob(apiJob, detail, tenant, companyName, input.descriptionFormat);
          if (post) jobPosts.push(post);
        } catch (err: any) {
          this.logger.warn(`Error processing isolved Hire role ${apiJob.id}: ${err.message}`);
        }
      }

      this.logger.log(`isolved Hire total: ${jobPosts.length} jobs for ${tenant}`);
      return new JobResponseDto(jobPosts);
    } catch (err: any) {
      this.logger.error(`isolved Hire scrape error for ${tenant}: ${err.message}`);
      return new JobResponseDto([]);
    }
  }

  /** GET the board HTML shell and extract domainId + companyName from componentData. */
  private async fetchBoardMeta(
    client: ReturnType<typeof createHttpClient>,
    tenant: string,
  ): Promise<IsolvedBoardMeta | null> {
    const url = `${isolvedCareerOrigin(tenant)}${ISOLVED_BOARD_PATH}`;
    const html = await this.fetchText(client, url, tenant);
    if (!html) return null;

    const domainIdMatch = ISOLVED_DOMAIN_ID_REGEX.exec(html);
    if (!domainIdMatch) return null;

    const domainId = domainIdMatch[1];
    const titleMatch = ISOLVED_DOMAIN_TITLE_REGEX.exec(html);
    const companyName = titleMatch ? titleMatch[1].trim() : null;

    return { domainId, companyName };
  }

  /** GET the core jobs API and return the parsed job array. */
  private async fetchCoreJobs(
    client: ReturnType<typeof createHttpClient>,
    tenant: string,
    domainId: string,
  ): Promise<IsolvedApiJob[]> {
    const url =
      `${isolvedCareerOrigin(tenant)}${ISOLVED_CORE_JOBS_PATH}${domainId}` +
      `?getParams=${encodeURIComponent(ISOLVED_GET_PARAMS)}`;
    try {
      const response = await client.get<{ success?: boolean; data?: { jobs?: IsolvedApiJob[] } }>(url, {
        responseType: 'json',
      });
      const jobs = response?.data?.data?.jobs;
      if (!Array.isArray(jobs)) {
        this.logger.warn(`isolved Hire core-jobs API returned no jobs array for "${tenant}"`);
        return [];
      }
      this.logger.log(`isolved Hire core-jobs API returned ${jobs.length} roles for ${tenant}`);
      return jobs;
    } catch (err: any) {
      this.logger.warn(`isolved Hire core-jobs API failed for "${tenant}": ${err?.message ?? err}`);
      return [];
    }
  }

  /**
   * Fan out to detail pages in bounded batches to extract the JSON-LD description
   * body and datePosted. Returns a Map keyed by jobId (string).
   */
  private async fetchDetailDescriptions(
    client: ReturnType<typeof createHttpClient>,
    tenant: string,
    jobs: IsolvedApiJob[],
  ): Promise<Map<string, IsolvedDetailData>> {
    const result = new Map<string, IsolvedDetailData>();

    for (let i = 0; i < jobs.length; i += ISOLVED_DETAIL_CONCURRENCY) {
      const batch = jobs.slice(i, i + ISOLVED_DETAIL_CONCURRENCY);
      const settled = await Promise.allSettled(
        batch.map(async (job) => {
          const jobId = String(job.id);
          const detailUrl = isolvedJobDetailUrl(tenant, jobId);
          const html = await this.fetchText(client, detailUrl, tenant);
          if (!html) return { jobId, data: null };
          const posting = this.extractJobPosting(html);
          return {
            jobId,
            data: posting
              ? {
                  descriptionHtml: this.cleanText(posting.description),
                  datePosted: this.parseDate(posting.datePosted),
                }
              : null,
          };
        }),
      );
      for (const r of settled) {
        if (r.status === 'fulfilled' && r.value.data) {
          result.set(r.value.jobId, r.value.data);
        }
      }
    }

    return result;
  }

  /** Map an API job + detail data → JobPostDto. */
  private processApiJob(
    apiJob: IsolvedApiJob,
    detail: IsolvedDetailData | null,
    tenant: string,
    companyName: string,
    format: DescriptionFormat | undefined,
  ): JobPostDto | null {
    const atsId = String(apiJob.id);
    const title = this.cleanText(apiJob.title);
    if (!title) return null;

    const jobUrl = isolvedJobDetailUrl(tenant, atsId);
    const city = this.cleanText(apiJob.city);
    const state = this.cleanText(apiJob.abbreviation);
    const country = this.normaliseCountry(this.cleanText(apiJob.iso3));
    const locationText = [city, state, country].filter((p): p is string => !!p).join(', ') || null;

    const department = this.resolveDepartment(apiJob);
    const compensation = this.buildCompensation(apiJob);
    const isRemote = this.resolveIsRemote(apiJob.workplaceType, title, locationText);
    const employmentType = this.cleanText(apiJob.employmentType);

    const datePosted = detail?.datePosted ?? null;
    const description = this.formatDescription(detail?.descriptionHtml ?? null, format);

    return new JobPostDto({
      id: `isolved-${atsId}`,
      title,
      companyName,
      jobUrl,
      location: this.buildLocation(city, state, country, isRemote),
      description,
      datePosted,
      isRemote,
      emails: extractEmails(description ?? ''),
      site: Site.ISOLVED,
      atsId,
      atsType: 'isolved',
      department,
      employmentType,
      compensation,
      applyUrl: jobUrl,
    });
  }

  /** Build a LocationDto from city/state/country parts, or null when all empty. */
  private buildLocation(
    city: string | null,
    state: string | null,
    country: string | null,
    isRemote: boolean,
  ): LocationDto | null {
    if (!city && !state && !country) {
      return isRemote ? new LocationDto({ city: 'Remote' }) : null;
    }
    return new LocationDto({ city, state, country });
  }

  /** Resolve department from the API's classification or orgTitle. */
  private resolveDepartment(apiJob: IsolvedApiJob): string | null {
    return this.cleanText(apiJob.classification) ?? this.cleanText(apiJob.orgTitle) ?? null;
  }

  /** Build CompensationDto from the API's salary fields. */
  private buildCompensation(apiJob: IsolvedApiJob): CompensationDto | null {
    const min = this.parseSalaryAmount(apiJob.minSalary);
    const max = this.parseSalaryAmount(apiJob.maxSalary);
    if (min == null && max == null) return null;

    const interval = this.parsePayInterval(apiJob.payTypeFrame);

    return new CompensationDto({
      minAmount: min,
      maxAmount: max,
      interval,
      currency: 'USD',
    });
  }

  /** Parse a salary string like "130,000.00" to a number. */
  private parseSalaryAmount(value: string | null | undefined): number | null {
    const cleaned = this.cleanText(value);
    if (!cleaned) return null;
    const num = parseFloat(cleaned.replace(/,/g, ''));
    return Number.isFinite(num) && num > 0 ? num : null;
  }

  /** Parse payTypeFrame (e.g. "per year") to CompensationInterval. */
  private parsePayInterval(payTypeFrame: string | null | undefined): CompensationInterval | null {
    const cleaned = this.cleanText(payTypeFrame);
    if (!cleaned) return null;
    const unit = cleaned.replace(/^per\s+/i, '').trim();
    return getCompensationInterval(unit);
  }

  /**
   * Resolve isRemote: structured workplaceType first, text heuristic fallback.
   * A workplaceType containing "remote" or "work from home" is treated as remote.
   */
  private resolveIsRemote(
    workplaceType: string | null | undefined,
    title: string | null,
    location: string | null,
  ): boolean {
    const wt = this.cleanText(workplaceType);
    if (wt && ISOLVED_WORKPLACE_REMOTE_REGEX.test(wt)) return true;
    for (const field of [title, location]) {
      if (typeof field === 'string' && ISOLVED_REMOTE_REGEX.test(field)) return true;
    }
    return false;
  }

  /** Convert ISO 3166-1 alpha-3 to alpha-2 where known, else pass through. */
  private normaliseCountry(iso3: string | null): string | null {
    if (!iso3) return null;
    return ISO3_TO_ISO2[iso3.toUpperCase()] ?? iso3;
  }

  /**
   * Extract the JSON-LD `JobPosting` object embedded in a role detail page.
   * Returns the first block whose `@type` is `JobPosting`.
   */
  private extractJobPosting(html: string): IsolvedJobPosting | null {
    ISOLVED_LD_JSON_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = ISOLVED_LD_JSON_REGEX.exec(html)) !== null) {
      const raw = match[1];
      if (!raw || !/JobPosting/i.test(raw)) continue;
      const posting = this.parseJobPosting(raw);
      if (posting) return posting;
    }
    return null;
  }

  /** Parse a JSON-LD block into a JobPosting, handling bare objects, arrays, and @graph. */
  private parseJobPosting(raw: string): IsolvedJobPosting | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }

    const candidates: unknown[] = [];
    if (Array.isArray(parsed)) {
      candidates.push(...parsed);
    } else if (parsed && typeof parsed === 'object') {
      const graph = (parsed as { '@graph'?: unknown })['@graph'];
      if (Array.isArray(graph)) candidates.push(...graph);
      candidates.push(parsed);
    }

    for (const c of candidates) {
      if (c && typeof c === 'object' && this.isJobPosting(c)) return c as IsolvedJobPosting;
    }
    return null;
  }

  /** True when a parsed JSON-LD object's `@type` is (or includes) `JobPosting`. */
  private isJobPosting(obj: object): boolean {
    const type = (obj as { '@type'?: unknown })['@type'];
    if (typeof type === 'string') return /^JobPosting$/i.test(type.trim());
    if (Array.isArray(type)) {
      return type.some((t) => typeof t === 'string' && /^JobPosting$/i.test(t.trim()));
    }
    return false;
  }

  /** Convert the HTML job-ad body per `descriptionFormat`. */
  private formatDescription(html: string | null, format?: DescriptionFormat): string | null {
    if (!html) return null;
    if (format === DescriptionFormat.HTML) return html;
    if (format === DescriptionFormat.MARKDOWN) return markdownConverter(html) ?? html;
    return htmlToPlainText(html) ?? html;
  }

  /**
   * GET a board URL as text. An HTTP 3xx (parked tenant), 4xx, 5xx, DNS, or
   * network error degrades to null (logged warn, no throw). Does NOT follow
   * redirects: a real tenant serves a direct 200; an unknown/parked tenant
   * 302-redirects off the board host.
   */
  private async fetchText(
    client: ReturnType<typeof createHttpClient>,
    url: string,
    tenant: string,
  ): Promise<string | null> {
    try {
      const response = await client.get<string>(url, {
        responseType: 'text',
        maxRedirects: 0,
      });
      return typeof response.data === 'string' ? response.data : null;
    } catch (err: any) {
      const status = err?.response?.status;
      if (status) {
        this.logger.warn(`isolved Hire board returned HTTP ${status} for ${tenant}`);
        return null;
      }
      this.logger.warn(`isolved Hire board fetch failed for ${tenant}: ${err?.message ?? err}`);
      return null;
    }
  }

  /**
   * Resolve the tenant slug from companySlug or companyUrl.
   * Accepts a bare slug, a full board URL, or a companyUrl on an isolvedhire.com host.
   */
  private resolveTenant(companySlug: string | undefined, companyUrl: string | undefined): string {
    if (companySlug && companySlug.trim()) {
      const slug = companySlug.trim();
      if (/^https?:\/\//i.test(slug) || slug.includes(ISOLVED_ROOT_DOMAIN)) {
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

  /** Derive the tenant token from an isolved Hire board URL. */
  private tenantFromUrl(value: string): string {
    const raw = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    try {
      const u = new URL(raw);
      const hostname = u.hostname.toLowerCase();
      if (!hostname.endsWith(ISOLVED_CAREER_HOST_SUFFIX)) return '';
      const label = hostname.slice(0, hostname.length - ISOLVED_CAREER_HOST_SUFFIX.length);
      if (!label || label === 'www') return '';
      return label.toLowerCase();
    } catch {
      return '';
    }
  }

  /** De-slugify + title-case the tenant token into a display company name. */
  private deriveCompanyName(tenant: string): string {
    const base = tenant && tenant.trim() ? tenant.trim() : tenant;
    return base.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /** Parse a date string to YYYY-MM-DD. Unparseable values yield null. */
  private parseDate(value: string | null | undefined): string | null {
    const cleaned = this.cleanText(value);
    if (!cleaned) return null;
    const isoish = cleaned.includes(' ') && /^\d{4}-\d{2}-\d{2}\s/.test(cleaned)
      ? cleaned.replace(' ', 'T')
      : cleaned;
    try {
      const parsed = new Date(isoish);
      if (!isNaN(parsed.getTime())) return toDateOnly(isoish);
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
