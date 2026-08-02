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
  JOBSOID_HOST_TEMPLATE,
  JOBSOID_JOBS_PATH,
  JOBSOID_JOB_PAGE_TEMPLATE,
  JOBSOID_APPLY_PAGE_TEMPLATE,
  JOBSOID_DEFAULT_RESULTS,
  JOBSOID_HEADERS,
} from './jobsoid.constants';
import { JobsoidJob, JobsoidJobsResponse } from './jobsoid.types';

/**
 * Jobsoid careers-portal scraper — generic, multi-tenant.
 *
 * Jobsoid is a cloud-based recruitment ATS. Every customer tenant gets a
 * public, branded careers portal served from its own sub-domain under the
 * shared apex `jobsoid.com` (e.g. `https://simpler.jobsoid.com/`). The portal
 * exposes a public, anonymous JSON jobs feed:
 *
 *   GET https://{tenant}.jobsoid.com/api/v1/jobs
 *     → HTTP 200, a flat JSON array of full job objects (no auth, no wrapper).
 *
 * The list endpoint embeds the FULL job record inline — including the HTML
 * `description`, structured `location`, `applyUrl`, and `hostedUrl` — so a
 * single GET yields everything; no per-job detail fan-out is needed. The
 * endpoint does not honour `offset` / `limit` query params, so the result-set
 * is sliced client-side to `resultsWanted` and de-duplicated by numeric `id`.
 *
 * The tenant sub-domain is resolved from `input.companySlug` (preferred) or
 * from the first sub-domain label of `input.companyUrl`. An unknown tenant
 * returns an empty array (`[]`, HTTP 200) rather than an error; a fetch error
 * or malformed payload likewise degrades to an empty/partial result rather
 * than throwing, so a single tenant never aborts a batch run.
 *
 * Verified live against `simpler.jobsoid.com` on 2026-06-03.
 */
@SourcePlugin({
  site: Site.JOBSOID,
  name: 'Jobsoid',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class JobsoidService implements IScraper {
  private readonly logger = new Logger(JobsoidService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    if (!input.companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for Jobsoid scraper');
      return new JobResponseDto([]);
    }

    const tenant = this.resolveTenant(input.companySlug, input.companyUrl);
    if (!tenant) {
      this.logger.warn('Could not resolve a Jobsoid tenant from input');
      return new JobResponseDto([]);
    }

    const host = JOBSOID_HOST_TEMPLATE.replace('{tenant}', encodeURIComponent(tenant));
    const companyName = this.deriveCompanyName(tenant);

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(JOBSOID_HEADERS);

    const resultsWanted = input.resultsWanted ?? JOBSOID_DEFAULT_RESULTS;
    const seen = new Set<string>();
    const jobPosts: JobPostDto[] = [];

    try {
      this.logger.log(`Fetching Jobsoid jobs for tenant: ${tenant}`);

      const jobs = await this.fetchJobs(client, host);
      if (jobs === null) {
        this.logger.warn(`Jobsoid tenant not found or no jobs: ${tenant}`);
        return new JobResponseDto([]);
      }

      this.logger.log(`Jobsoid feed returned ${jobs.length} jobs for ${tenant}`);

      for (const job of jobs) {
        if (jobPosts.length >= resultsWanted) break;
        try {
          const post = this.processJob(job, tenant, companyName, input.descriptionFormat);
          if (!post) continue;
          const key = post.atsId as string;
          if (seen.has(key)) continue;
          seen.add(key);
          jobPosts.push(post);
        } catch (err: any) {
          this.logger.warn(`Error processing Jobsoid job ${job?.id ?? '?'}: ${err.message}`);
        }
      }

      const trimmed = jobPosts.slice(0, resultsWanted);
      this.logger.log(`Jobsoid total: ${trimmed.length} jobs for ${companyName}`);
      return new JobResponseDto(trimmed);
    } catch (err: any) {
      this.logger.error(`Jobsoid scrape error for ${tenant}: ${err.message}`);
      return new JobResponseDto(jobPosts.slice(0, resultsWanted)); // partial results
    }
  }

  /**
   * Fetch the public jobs feed for a tenant. Returns the parsed job array, or
   * null when the tenant is unknown / the feed is unreachable (HTTP 4xx). The
   * Jobsoid API returns `[]` (HTTP 200) for unknown tenants and empty tenants,
   * which is mapped to an empty array (not null).
   */
  private async fetchJobs(
    client: ReturnType<typeof createHttpClient>,
    host: string,
  ): Promise<JobsoidJob[] | null> {
    const url = `${host}${JOBSOID_JOBS_PATH}`;
    try {
      const response = await client.get<JobsoidJobsResponse>(url);
      const body = response.data;
      if (Array.isArray(body)) return body;
      // Unexpected (non-array) payload → treat as no jobs, degrade gracefully.
      this.logger.warn(`Jobsoid feed returned a non-array payload for ${host}`);
      return [];
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 400 || status === 403 || status === 404) {
        this.logger.warn(`Jobsoid feed not found (HTTP ${status}) for ${host}`);
        return null;
      }
      throw err;
    }
  }

  /** Map a single Jobsoid job record to a `JobPostDto`; returns null for invalid items. */
  private processJob(
    job: JobsoidJob,
    tenant: string,
    companyName: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const title = job.title?.trim();
    if (!title) return null;

    const atsId = job.id != null ? String(job.id) : '';
    if (!atsId) return null;

    const jobUrl = this.buildJobUrl(job, tenant, atsId);
    const applyUrl = job.applyUrl?.trim() || this.buildApplyUrl(tenant, atsId);

    const rawDescription = job.description?.trim() || null;
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

    const department =
      job.department?.title?.trim() ||
      job.function?.title?.trim() ||
      job.industry?.trim() ||
      null;

    const resolvedCompanyName = job.company?.trim() || companyName;

    return new JobPostDto({
      id: `jobsoid-${atsId}`,
      title,
      companyName: resolvedCompanyName,
      jobUrl,
      location: this.extractLocation(job),
      description,
      datePosted: this.parseDate(job.postedDate),
      isRemote: this.detectRemote(job),
      emails: extractEmails(description),
      site: Site.JOBSOID,
      atsId,
      atsType: 'jobsoid',
      department,
      applyUrl,
    });
  }

  /** Resolve the tenant sub-domain from an explicit slug or a career URL. */
  private resolveTenant(
    companySlug: string | undefined,
    companyUrl: string | undefined,
  ): string {
    if (companySlug && companySlug.trim()) {
      // A slug may be a bare label ("simpler") or a full host ("simpler.jobsoid.com").
      const slug = companySlug.trim();
      if (slug.includes('.')) {
        const label = slug.split('.').filter(Boolean)[0];
        if (label) return label;
      }
      return slug;
    }
    if (companyUrl) {
      try {
        const u = new URL(companyUrl);
        const hostname = u.hostname.split(':')[0];
        const labels = hostname.split('.').filter(Boolean);
        const label = labels[0];
        if (label && label !== 'www') return label;
      } catch {
        // Malformed URL — no tenant recoverable.
      }
    }
    return '';
  }

  /**
   * Build the public job-detail page URL. Prefers the `hostedUrl` returned by
   * the API; falls back to the canonical `/j/{id}/{slug}` template.
   */
  private buildJobUrl(job: JobsoidJob, tenant: string, atsId: string): string {
    const hosted = job.hostedUrl?.trim();
    if (hosted) return hosted;
    const slug = job.slug?.trim() || '';
    return JOBSOID_JOB_PAGE_TEMPLATE.replace('{tenant}', encodeURIComponent(tenant))
      .replace('{id}', encodeURIComponent(atsId))
      .replace('{slug}', encodeURIComponent(slug));
  }

  /** Build the public apply page URL from the tenant + job id. */
  private buildApplyUrl(tenant: string, atsId: string): string {
    return JOBSOID_APPLY_PAGE_TEMPLATE.replace('{tenant}', encodeURIComponent(tenant)).replace(
      '{id}',
      encodeURIComponent(atsId),
    );
  }

  /** Derive a human-readable company name from the tenant sub-domain label. */
  private deriveCompanyName(tenant: string): string {
    return tenant.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /**
   * Extract a `LocationDto` from the structured `location` block. Falls back to
   * splitting the free-text `title` label when the structured fields are empty.
   */
  private extractLocation(job: JobsoidJob): LocationDto | null {
    const loc = job.location;
    if (!loc) return null;

    const city = loc.city?.trim() || null;
    const state = loc.state?.trim() || null;
    const country = loc.country?.trim() || null;

    if (city || state || country) {
      return new LocationDto({ city, state, country });
    }

    // Fall back to the combined free-text label (e.g. "Milan - Milan").
    const label = loc.title?.trim();
    if (!label) return null;
    const parts = label
      .split(/[-,]/)
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length === 0) return null;
    return new LocationDto({ city: parts[0] ?? null, state: parts[1] ?? null, country: null });
  }

  /**
   * Detect remote roles from the job title, location, or type.
   * Jobsoid does not expose a dedicated remote flag in the public feed.
   */
  private detectRemote(job: JobsoidJob): boolean {
    const haystacks = [job.title, job.location?.title, job.location?.city, job.type];
    for (const field of haystacks) {
      if (typeof field !== 'string') continue;
      const v = field.toLowerCase();
      if (v.includes('remote') || v.includes('work from home') || v.includes('wfh')) {
        return true;
      }
    }
    return false;
  }

  /**
   * Parse an ISO-8601-ish timestamp (e.g. "2026-05-12T01:00:23.013") into a
   * `YYYY-MM-DD` string. Returns null for null/undefined or unparseable input.
   */
  private parseDate(value: string | null | undefined): string | null {
    if (!value) return null;
    try {
      const parsed = new Date(value.trim());
      if (!isNaN(parsed.getTime())) return toDateOnly(value.trim());
    } catch {
      // ignore
    }
    return null;
  }
}
