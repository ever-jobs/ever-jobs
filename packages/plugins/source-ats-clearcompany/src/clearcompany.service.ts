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
  CLEARCOMPANY_HOST,
  CLEARCOMPANY_JOBS_PATH,
  CLEARCOMPANY_JOB_PAGE_TEMPLATE,
  CLEARCOMPANY_SHORTNAME_HEADER,
  CLEARCOMPANY_DEFAULT_RESULTS,
  CLEARCOMPANY_HEADERS,
} from './clearcompany.constants';
import { ClearCompanyJob, ClearCompanyJobsResponse } from './clearcompany.types';

/**
 * ClearCompany ATS careers scraper — generic, multi-tenant.
 *
 * ClearCompany serves every customer's public careers site from one shared
 * host (`https://careers-page.clearcompany.com/jobs/{slug}`). The public,
 * unauthenticated jobs feed is a single endpoint that resolves the tenant from
 * the `API-ShortName` header (the careers slug) and returns the full open-roles
 * list as a flat JSON array — there is no server-side pagination, so we fetch
 * once and slice client-side to honour `resultsWanted`.
 *
 * The tenant slug is taken from `companySlug` or derived from a custom
 * `companyUrl` (its first sub-domain label). A single fetch error, an unknown
 * tenant (HTTP 400 from the feed), or a malformed payload degrades to an empty
 * result rather than throwing, so a single tenant never nukes a batch run.
 */
@SourcePlugin({
  site: Site.CLEARCOMPANY,
  name: 'ClearCompany',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class ClearCompanyService implements IScraper {
  private readonly logger = new Logger(ClearCompanyService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for ClearCompany scraper');
      return new JobResponseDto([]);
    }

    const slug = this.resolveSlug(companySlug, input.companyUrl);
    if (!slug) {
      this.logger.warn('Could not resolve a ClearCompany tenant slug from input');
      return new JobResponseDto([]);
    }
    const companyName = this.deriveCompanyName(slug);

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(CLEARCOMPANY_HEADERS);

    const resultsWanted = input.resultsWanted ?? CLEARCOMPANY_DEFAULT_RESULTS;
    const seen = new Set<string>();
    const jobPosts: JobPostDto[] = [];

    try {
      this.logger.log(`Fetching ClearCompany jobs for tenant: ${slug}`);

      // The feed returns every open role for the tenant in a single response.
      const jobs = await this.fetchJobs(client, slug);
      this.collect(jobs, slug, companyName, input.descriptionFormat, seen, jobPosts);

      const trimmed = jobPosts.slice(0, resultsWanted);
      this.logger.log(`ClearCompany total: ${trimmed.length} jobs for ${companyName}`);
      return new JobResponseDto(trimmed);
    } catch (err: any) {
      this.logger.error(`ClearCompany scrape error for ${slug}: ${err.message}`);
      // Partial results WITH a reason: jobs.length > 0 plus a diagnostic is
      // inferred as 'partial' upstream, so a mid-scrape failure is no longer
      // indistinguishable from a complete board.
      return new JobResponseDto(jobPosts.slice(0, resultsWanted), classifyScrapeError(err));
    }
  }

  /** Fetch the tenant's full open-roles array from the public careers feed. */
  private async fetchJobs(
    client: ReturnType<typeof createHttpClient>,
    slug: string,
  ): Promise<ClearCompanyJob[]> {
    const url = `${CLEARCOMPANY_HOST}${CLEARCOMPANY_JOBS_PATH}`;
    try {
      const response = await client.get<ClearCompanyJobsResponse>(url, {
        headers: { [CLEARCOMPANY_SHORTNAME_HEADER]: slug },
      });
      const data = response.data;
      return Array.isArray(data) ? data : [];
    } catch (err: any) {
      // An unknown / dead tenant returns HTTP 400 with an explanatory message;
      // treat that as "no jobs" rather than a hard failure.
      const status = err?.response?.status;
      if (status === 400 || status === 404) {
        this.logger.warn(`ClearCompany tenant "${slug}" not found (HTTP ${status})`);
        return [];
      }
      throw err;
    }
  }

  /** Map raw jobs → JobPostDto, de-duplicating by ATS id within this run. */
  private collect(
    jobs: ClearCompanyJob[],
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
        this.logger.warn(`Error processing ClearCompany job ${job?.Id ?? job?.id}: ${err.message}`);
      }
    }
  }

  private processJob(
    job: ClearCompanyJob,
    slug: string,
    companyName: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const title = job.PositionTitle ?? job.positionTitle ?? job.Title ?? job.title;
    if (!title) return null;

    const atsId = String(job.Id ?? job.id ?? '');
    if (!atsId) return null;

    const jobUrl = this.buildJobUrl(slug, atsId);
    const applyUrl = job.ApplyUrl ?? job.applyUrl ?? jobUrl;

    const rawDescription = job.Description ?? job.description ?? null;
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

    const department = job.DepartmentName ?? null;

    return new JobPostDto({
      id: `clearcompany-${atsId}`,
      title,
      companyName: this.normalizeCompanyName(job.OrganizationName) ?? companyName,
      jobUrl,
      location: this.extractLocation(job),
      description,
      datePosted: this.parseDate(job.OpenDate ?? job.openDate),
      isRemote: this.detectRemote(job),
      emails: extractEmails(description),
      site: Site.CLEARCOMPANY,
      atsId,
      atsType: 'clearcompany',
      department,
      applyUrl,
    });
  }

  /** Resolve the careers slug from an explicit slug or a custom careers URL. */
  private resolveSlug(companySlug: string | undefined, companyUrl: string | undefined): string {
    if (companySlug && companySlug.trim()) return companySlug.trim();
    if (companyUrl) {
      try {
        const u = new URL(companyUrl);
        // ClearCompany careers pages encode the tenant in the path: /jobs/{slug}.
        const segments = u.pathname.split('/').filter(Boolean);
        const jobsIdx = segments.indexOf('jobs');
        if (jobsIdx >= 0 && segments[jobsIdx + 1]) return segments[jobsIdx + 1];
        // Otherwise fall back to the first sub-domain label (custom domains).
        const host = u.host.split(':')[0];
        const label = host.split('.')[0];
        if (label && label !== 'www' && label !== 'careers-page') return label;
      } catch {
        // Malformed URL — no slug recoverable.
      }
    }
    return '';
  }

  /** Build the public job-detail page URL for the tenant. */
  private buildJobUrl(slug: string, atsId: string): string {
    const path = CLEARCOMPANY_JOB_PAGE_TEMPLATE.replace('{slug}', encodeURIComponent(slug)).replace(
      '{id}',
      encodeURIComponent(atsId),
    );
    return `${CLEARCOMPANY_HOST}${path}`;
  }

  /**
   * ClearCompany `OrganizationName` often carries a numeric suffix
   * (e.g. "ClearCompany-1132"); strip it when present, else fall back to the
   * slug-derived name.
   */
  private normalizeCompanyName(organizationName: string | null | undefined): string | null {
    if (!organizationName) return null;
    const cleaned = organizationName.replace(/-\d+$/, '').trim();
    return cleaned || null;
  }

  private deriveCompanyName(slug: string): string {
    return slug
      .replace(/[-_]+/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /** ClearCompany emits a free-text `OfficeName` like "Copley Square, Boston". */
  private extractLocation(job: ClearCompanyJob): LocationDto | null {
    const office = job.OfficeName;
    if (typeof office !== 'string' || !office.trim()) return null;
    const parts = office
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length === 0) return null;
    if (parts.length === 1) {
      return new LocationDto({ city: parts[0], state: null, country: null });
    }
    // Two-plus parts: treat last as state/region, first as city.
    const city = parts[0];
    const state = parts.length >= 3 ? parts[1] : parts[parts.length - 1];
    const country = parts.length >= 3 ? parts[parts.length - 1] : null;
    return new LocationDto({ city: city ?? null, state: state ?? null, country: country ?? null });
  }

  /** Detect remote roles from the office/location label or the title. */
  private detectRemote(job: ClearCompanyJob): boolean {
    const haystacks = [job.OfficeName, job.PositionTitle ?? job.positionTitle];
    for (const field of haystacks) {
      if (typeof field !== 'string') continue;
      const v = field.toLowerCase();
      if (v.includes('remote') || v.includes('work from home') || v.includes('wfh')) return true;
    }
    return false;
  }

  /** Parse epoch-seconds, epoch-ms, or ISO strings into a YYYY-MM-DD string. */
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
