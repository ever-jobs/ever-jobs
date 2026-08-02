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
  GOHIRE_HOST,
  GOHIRE_LIST_API_HOST,
  GOHIRE_DETAIL_API_HOST,
  GOHIRE_JOBS_PATH,
  GOHIRE_JOB_DETAIL_PATH,
  GOHIRE_MAX_CONCURRENCY,
  GOHIRE_DEFAULT_RESULTS,
  GOHIRE_HEADERS,
} from './gohire.constants';
import {
  GoHireListJob,
  GoHireJobsResponse,
  GoHireJobDetail,
} from './gohire.types';

/**
 * GoHire ATS careers scraper — generic, multi-tenant.
 *
 * GoHire serves every customer's public careers board from one shared host
 * (`https://jobs.gohire.io/{clientHash}`). The public, unauthenticated list
 * feed (`https://api2.gohire.io/widget-jobs/{clientHash}`) returns the tenant's
 * full open-roles set in one response (no server-side pagination), but with an
 * empty `description`; we fan out to the per-job detail feed
 * (`https://api.gohire.io/widget-job?clientHash={hash}&jobId={id}`) with a
 * bounded `Promise.allSettled` to hydrate the full HTML description, structured
 * location and employer name, then slice client-side to honour `resultsWanted`.
 *
 * The tenant client hash is taken from `companySlug` or derived from a custom
 * `companyUrl` (its `/jobs.gohire.io/{slug}` path segment, the last `-`-suffixed
 * label of a board path, or the first sub-domain label). An unknown tenant
 * (the list feed returns `{}` with no `jobs`), a single fetch error, or a
 * malformed payload degrades to a partial/empty result rather than throwing, so
 * a single tenant never nukes a batch run.
 */
@SourcePlugin({
  site: Site.GOHIRE,
  name: 'GoHire',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class GoHireService implements IScraper {
  private readonly logger = new Logger(GoHireService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for GoHire scraper');
      return new JobResponseDto([]);
    }

    const slug = this.resolveSlug(companySlug, input.companyUrl);
    if (!slug) {
      this.logger.warn('Could not resolve a GoHire tenant slug from input');
      return new JobResponseDto([]);
    }
    const fallbackCompanyName = this.deriveCompanyName(slug);

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(GOHIRE_HEADERS);

    const resultsWanted = input.resultsWanted ?? GOHIRE_DEFAULT_RESULTS;
    const seen = new Set<string>();
    const jobPosts: JobPostDto[] = [];

    try {
      this.logger.log(`Fetching GoHire jobs for tenant: ${slug}`);

      // The list feed returns every open role for the tenant in one response.
      const listJobs = await this.fetchJobs(client, slug);

      // De-dup the list by numeric id, drop the general-application pool entries,
      // and cap to what the caller wants before fanning out to detail fetches.
      const candidates: GoHireListJob[] = [];
      for (const job of listJobs) {
        const atsId = String(job.id ?? '');
        if (!atsId || seen.has(atsId)) continue;
        seen.add(atsId);
        candidates.push(job);
        if (candidates.length >= resultsWanted) break;
      }

      // Bounded concurrent fan-out to hydrate each role's detail payload.
      for (let i = 0; i < candidates.length; i += GOHIRE_MAX_CONCURRENCY) {
        const chunk = candidates.slice(i, i + GOHIRE_MAX_CONCURRENCY);
        const settled = await Promise.allSettled(
          chunk.map((job) => this.hydrate(client, slug, job)),
        );
        for (let j = 0; j < settled.length; j++) {
          const result = settled[j];
          const detail = result.status === 'fulfilled' ? result.value : null;
          if (result.status === 'rejected') {
            this.logger.warn(
              `GoHire detail fetch failed for ${chunk[j].id}: ${result.reason?.message ?? result.reason}`,
            );
          }
          try {
            const post = this.processJob(chunk[j], detail, slug, fallbackCompanyName, input.descriptionFormat);
            if (post) jobPosts.push(post);
          } catch (err: any) {
            this.logger.warn(`Error processing GoHire job ${chunk[j]?.id}: ${err.message}`);
          }
        }
      }

      const trimmed = jobPosts.slice(0, resultsWanted);
      this.logger.log(`GoHire total: ${trimmed.length} jobs for ${slug}`);
      return new JobResponseDto(trimmed);
    } catch (err: any) {
      this.logger.error(`GoHire scrape error for ${slug}: ${err.message}`);
      return new JobResponseDto(jobPosts.slice(0, resultsWanted)); // partial results
    }
  }

  /** Fetch the tenant's full open-roles array from the public list feed. */
  private async fetchJobs(
    client: ReturnType<typeof createHttpClient>,
    slug: string,
  ): Promise<GoHireListJob[]> {
    const url = `${GOHIRE_LIST_API_HOST}${GOHIRE_JOBS_PATH}/${encodeURIComponent(slug)}`;
    try {
      const response = await client.get<GoHireJobsResponse>(url);
      const data = response.data;
      // An unknown tenant returns `{}` (HTTP 200) with no `jobs` key.
      return Array.isArray(data?.jobs) ? (data.jobs as GoHireListJob[]) : [];
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 400 || status === 404) {
        this.logger.warn(`GoHire tenant "${slug}" not found (HTTP ${status})`);
        return [];
      }
      throw err;
    }
  }

  /** Fetch a single role's detail payload; null on any failure (best-effort). */
  private async hydrate(
    client: ReturnType<typeof createHttpClient>,
    slug: string,
    job: GoHireListJob,
  ): Promise<GoHireJobDetail | null> {
    const atsId = String(job.id ?? '');
    if (!atsId) return null;
    const url =
      `${GOHIRE_DETAIL_API_HOST}${GOHIRE_JOB_DETAIL_PATH}` +
      `?clientHash=${encodeURIComponent(slug)}&jobId=${encodeURIComponent(atsId)}`;
    const response = await client.get<GoHireJobDetail>(url);
    const data = response.data;
    return data && typeof data === 'object' ? data : null;
  }

  /** Map a list role (+ optional detail) → JobPostDto. */
  private processJob(
    job: GoHireListJob,
    detail: GoHireJobDetail | null,
    slug: string,
    fallbackCompanyName: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const title = detail?.title ?? job.title;
    if (!title) return null;

    const atsId = String(job.id ?? detail?.id ?? '');
    if (!atsId) return null;

    const jobUrl = this.buildJobUrl(job, slug, atsId);

    const rawDescription = detail?.description ?? job.description ?? null;
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

    const department = this.extractType(detail?.type) ?? job.type ?? null;

    return new JobPostDto({
      id: `gohire-${atsId}`,
      title,
      companyName: detail?.client?.name ?? fallbackCompanyName,
      jobUrl,
      location: this.extractLocation(job, detail),
      description,
      datePosted: this.parseDate(job.date),
      isRemote: this.detectRemote(job, detail),
      emails: extractEmails(description),
      site: Site.GOHIRE,
      atsId,
      atsType: 'gohire',
      department,
      applyUrl: jobUrl,
    });
  }

  /** Resolve the careers client hash from an explicit slug or a custom board URL. */
  private resolveSlug(companySlug: string | undefined, companyUrl: string | undefined): string {
    if (companySlug && companySlug.trim()) return companySlug.trim();
    if (companyUrl) {
      try {
        const u = new URL(companyUrl);
        const segments = u.pathname.split('/').filter(Boolean);
        // Board pages look like /{company}-{clientHash}/{job-slug}-{jobId}/;
        // the first path segment ends with the opaque hash after the last '-'.
        if (segments[0]) {
          const first = segments[0];
          const dashIdx = first.lastIndexOf('-');
          if (dashIdx >= 0 && dashIdx < first.length - 1) {
            return first.slice(dashIdx + 1);
          }
          // A bare /{clientHash} board path.
          return first;
        }
        // Otherwise fall back to the first sub-domain label (custom domains).
        const host = u.host.split(':')[0];
        const label = host.split('.')[0];
        if (label && label !== 'www' && label !== 'jobs' && label !== 'careers') return label;
      } catch {
        // Malformed URL — no slug recoverable.
      }
    }
    return '';
  }

  /** Prefer the list feed's absolute `link`; otherwise synthesise a board URL. */
  private buildJobUrl(job: GoHireListJob, slug: string, atsId: string): string {
    if (typeof job.link === 'string' && job.link.trim()) return job.link.trim();
    return `${GOHIRE_HOST}/${encodeURIComponent(slug)}/${encodeURIComponent(atsId)}/`;
  }

  private deriveCompanyName(slug: string): string {
    return slug.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /** Normalise the detail feed's `type` (object or string) to a label. */
  private extractType(type: GoHireJobDetail['type']): string | null {
    if (!type) return null;
    if (typeof type === 'string') return type.trim() || null;
    return type.name ?? null;
  }

  /**
   * Build a LocationDto from the detail feed's structured parts when present,
   * else heuristically split the list feed's free-text "City, Country" label.
   */
  private extractLocation(job: GoHireListJob, detail: GoHireJobDetail | null): LocationDto | null {
    if (detail) {
      const city = detail.city ?? null;
      const country = this.extractCountry(detail.country);
      const state = detail.county && detail.county !== city ? detail.county : null;
      if (city || state || country) {
        return new LocationDto({ city, state, country });
      }
    }
    const label = job.location;
    if (typeof label !== 'string' || !label.trim()) return null;
    const parts = label.split(',').map((p) => p.trim()).filter(Boolean);
    if (parts.length === 0) return null;
    if (parts.length === 1) {
      return new LocationDto({ city: parts[0], state: null, country: null });
    }
    // Two-plus parts: first is city, last is country, middle (if any) is state.
    const city = parts[0];
    const country = parts[parts.length - 1];
    const state = parts.length >= 3 ? parts[1] : null;
    return new LocationDto({ city: city ?? null, state, country: country ?? null });
  }

  /** Normalise the detail feed's `country` (object or string) to a label. */
  private extractCountry(country: GoHireJobDetail['country']): string | null {
    if (!country) return null;
    if (typeof country === 'string') return country.trim() || null;
    return country.name ?? null;
  }

  /** Detect remote roles from the location label or the title. */
  private detectRemote(job: GoHireListJob, detail: GoHireJobDetail | null): boolean {
    const haystacks = [job.location, job.title, detail?.city, detail?.title];
    for (const field of haystacks) {
      if (typeof field !== 'string') continue;
      const v = field.toLowerCase();
      if (v.includes('remote') || v.includes('work from home') || v.includes('wfh')) return true;
    }
    return false;
  }

  /**
   * Parse GoHire's human date ("28 May, 2026"), an ISO string, or an
   * epoch-seconds/ms number into a YYYY-MM-DD string.
   */
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
