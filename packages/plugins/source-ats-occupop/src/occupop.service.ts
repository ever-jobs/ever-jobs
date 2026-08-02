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
  OCCUPOP_GRAPHQL_ENDPOINT,
  OCCUPOP_CAREERS_HOST_TEMPLATE,
  OCCUPOP_JOB_PAGE_TEMPLATE,
  OCCUPOP_LIVE_JOBS_OPERATION,
  OCCUPOP_LIVE_JOBS_QUERY,
  OCCUPOP_DEFAULT_RESULTS,
  OCCUPOP_HEADERS,
} from './occupop.constants';
import { OccupopJob, OccupopLiveJobsResponse } from './occupop.types';

/**
 * Occupop ATS careers scraper — generic, multi-tenant.
 *
 * Occupop serves every customer's public careers site as a per-tenant
 * sub-domain (`https://{slug}.occupop-careers.com`) backed by one shared,
 * unauthenticated Apollo GraphQL gateway. The `LiveJobs` operation resolves the
 * tenant from the `companyKey` variable (the careers slug) and returns the full
 * live-roles list as a flat array — there is no server-side pagination, so we
 * fetch once and slice client-side to honour `resultsWanted`.
 *
 * The tenant slug is taken from `companySlug` or derived from a custom
 * `companyUrl` (its first sub-domain label). A single fetch error, an unknown
 * tenant (GraphQL `"Invalid company key!"`), or a malformed payload degrades to
 * an empty result rather than throwing, so a single tenant never nukes a batch
 * run.
 */
@SourcePlugin({
  site: Site.OCCUPOP,
  name: 'Occupop',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class OccupopService implements IScraper {
  private readonly logger = new Logger(OccupopService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for Occupop scraper');
      return new JobResponseDto([]);
    }

    const slug = this.resolveSlug(companySlug, input.companyUrl);
    if (!slug) {
      this.logger.warn('Could not resolve an Occupop tenant slug from input');
      return new JobResponseDto([]);
    }
    const companyName = this.deriveCompanyName(slug);

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(OCCUPOP_HEADERS);

    const resultsWanted = input.resultsWanted ?? OCCUPOP_DEFAULT_RESULTS;
    const seen = new Set<string>();
    const jobPosts: JobPostDto[] = [];

    try {
      this.logger.log(`Fetching Occupop jobs for tenant: ${slug}`);

      // The gateway returns every live role for the tenant in a single response.
      const jobs = await this.fetchJobs(client, slug);
      this.collect(jobs, slug, companyName, input.descriptionFormat, seen, jobPosts);

      const trimmed = jobPosts.slice(0, resultsWanted);
      this.logger.log(`Occupop total: ${trimmed.length} jobs for ${companyName}`);
      return new JobResponseDto(trimmed);
    } catch (err: any) {
      this.logger.error(`Occupop scrape error for ${slug}: ${err.message}`);
      return new JobResponseDto(jobPosts.slice(0, resultsWanted)); // partial results
    }
  }

  /** Fetch the tenant's full live-roles array from the public GraphQL gateway. */
  private async fetchJobs(
    client: ReturnType<typeof createHttpClient>,
    slug: string,
  ): Promise<OccupopJob[]> {
    const body = {
      operationName: OCCUPOP_LIVE_JOBS_OPERATION,
      query: OCCUPOP_LIVE_JOBS_QUERY,
      variables: { companyKey: slug, tags: [] as string[], includeAllBrandsJobs: false },
    };

    try {
      const response = await client.post<OccupopLiveJobsResponse>(OCCUPOP_GRAPHQL_ENDPOINT, body);
      const payload = response.data;

      // An unknown / dead tenant returns HTTP 200 with a GraphQL `errors` entry
      // ("Invalid company key!") and `data: null`; treat that as "no jobs".
      if (Array.isArray(payload?.errors) && payload.errors.length > 0) {
        const message = payload.errors[0]?.message ?? 'unknown GraphQL error';
        this.logger.warn(`Occupop tenant "${slug}" rejected by gateway: ${message}`);
        return [];
      }

      const jobs = payload?.data?.careersPage?.liveJobs;
      return Array.isArray(jobs) ? jobs : [];
    } catch (err: any) {
      // A dead sub-domain or gateway 4xx degrades to "no jobs" rather than a hard
      // failure.
      const status = err?.response?.status;
      if (status === 400 || status === 404) {
        this.logger.warn(`Occupop tenant "${slug}" not found (HTTP ${status})`);
        return [];
      }
      throw err;
    }
  }

  /** Map raw jobs → JobPostDto, de-duplicating by ATS id within this run. */
  private collect(
    jobs: OccupopJob[],
    slug: string,
    companyName: string,
    format: DescriptionFormat | undefined,
    seen: Set<string>,
    out: JobPostDto[],
  ): void {
    for (const job of jobs) {
      try {
        const post = this.processJob(job, slug, companyName, format);
        if (!post) continue;
        // processJob guarantees a non-empty atsId (returns null otherwise).
        const key = post.atsId as string;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(post);
      } catch (err: any) {
        this.logger.warn(`Error processing Occupop job ${job?.uuid ?? job?.id}: ${err.message}`);
      }
    }
  }

  private processJob(
    job: OccupopJob,
    slug: string,
    companyName: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const title = job.title;
    if (!title) return null;

    const atsId = String(job.uuid ?? job.id ?? '');
    if (!atsId) return null;

    const jobUrl = this.buildJobUrl(slug, atsId);

    const rawDescription = job.description ?? null;
    let description: string | null = null;
    if (rawDescription) {
      if (format === DescriptionFormat.HTML) {
        description = rawDescription;
      } else if (format === DescriptionFormat.MARKDOWN) {
        description = markdownConverter(rawDescription) ?? rawDescription;
      } else {
        description = htmlToPlainText(rawDescription);
      }
    }

    const department = this.extractDepartment(job);

    return new JobPostDto({
      id: `occupop-${atsId}`,
      title,
      companyName: job.companyName ?? job.hiringCompany?.name ?? companyName,
      jobUrl,
      location: this.extractLocation(job),
      description,
      datePosted: this.parseDate(job.publishedAt ?? job.published_at ?? job.createdAt),
      isRemote: this.detectRemote(job),
      emails: extractEmails(description),
      site: Site.OCCUPOP,
      atsId,
      atsType: 'occupop',
      department,
      employmentType: job.period ?? null,
      applyUrl: jobUrl,
    });
  }

  /** Resolve the careers slug from an explicit slug or a custom careers URL. */
  private resolveSlug(companySlug: string | undefined, companyUrl: string | undefined): string {
    if (companySlug && companySlug.trim()) return companySlug.trim();
    if (companyUrl) {
      try {
        const u = new URL(companyUrl);
        // Occupop careers pages encode the tenant as the first sub-domain label
        // (`{slug}.occupop-careers.com`).
        const host = u.host.split(':')[0];
        const label = host.split('.')[0];
        if (label && label !== 'www') return label;
      } catch {
        // Malformed URL — no slug recoverable.
      }
    }
    return '';
  }

  /** Build the public job-detail / apply page URL for the tenant. */
  private buildJobUrl(slug: string, atsId: string): string {
    const host = OCCUPOP_CAREERS_HOST_TEMPLATE.replace('{slug}', encodeURIComponent(slug));
    const path = OCCUPOP_JOB_PAGE_TEMPLATE.replace('{id}', encodeURIComponent(atsId));
    return `${host}${path}`;
  }

  private deriveCompanyName(slug: string): string {
    return slug
      .replace(/[-_]+/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /** Department = the first sub-sector's parent sector, else the sub-sector name. */
  private extractDepartment(job: OccupopJob): string | null {
    const first = Array.isArray(job.subsectors) ? job.subsectors[0] : null;
    if (!first) return null;
    return first.sector?.name ?? first.name ?? null;
  }

  /** Occupop emits a structured `{ city, country }` location object. */
  private extractLocation(job: OccupopJob): LocationDto | null {
    const loc = job.location;
    if (!loc || typeof loc !== 'object') return null;
    const city = loc.city?.trim() || null;
    const country = loc.country?.trim() || null;
    const state = loc.region?.trim() || null;
    if (!city && !country && !state) return null;
    return new LocationDto({ city, state, country });
  }

  /** Detect remote roles from the location, employment period, or the title. */
  private detectRemote(job: OccupopJob): boolean {
    const haystacks = [job.location?.city, job.location?.country, job.period, job.title];
    for (const field of haystacks) {
      if (typeof field !== 'string') continue;
      const v = field.toLowerCase();
      if (v.includes('remote') || v.includes('work from home') || v.includes('wfh')) return true;
    }
    return false;
  }

  /** Parse epoch-seconds, epoch-ms, or date-time strings into a YYYY-MM-DD string. */
  private parseDate(value: string | number | null | undefined): string | null {
    if (value == null) return null;
    try {
      if (typeof value === 'number') {
        const ms = value > 1e12 ? value : value > 1e10 ? value : value * 1000;
        return toDateOnly(ms);
      }
      const parsed = new Date(value);
      if (!isNaN(parsed.getTime())) return toDateOnly(value);
    } catch {
      // ignore
    }
    return null;
  }
}
