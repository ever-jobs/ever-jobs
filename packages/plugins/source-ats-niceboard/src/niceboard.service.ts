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
  randomSleep,
  toDateOnly,
} from '@ever-jobs/common';
import {
  NICEBOARD_HOST_TEMPLATE,
  NICEBOARD_JOBS_PATH,
  NICEBOARD_JOB_PAGE_TEMPLATE,
  NICEBOARD_JOB_PAGE_ANON_TEMPLATE,
  NICEBOARD_PAGE_SIZE,
  NICEBOARD_MAX_CONCURRENCY,
  NICEBOARD_REQUEST_DELAY_MS,
  NICEBOARD_DEFAULT_RESULTS,
  NICEBOARD_BASE_PARAMS,
  NICEBOARD_HEADERS,
} from './niceboard.constants';
import { NiceboardJob, NiceboardJobsResponse } from './niceboard.types';

/**
 * Niceboard hosted job-board scraper — generic, multi-tenant.
 *
 * Niceboard serves every tenant board from its own sub-domain under the shared
 * apex `niceboard.co` (e.g. `https://avajobboard.niceboard.co`). The board's
 * own front-end fetches listings from a public, anonymous search endpoint —
 * `GET /api/jobs` — which returns `{ jobs: [...], count }` with the full job
 * objects (including `description_html`) embedded. We page that endpoint with a
 * bounded concurrent fan-out; the first page yields the true total `count`.
 *
 * The board sub-domain is taken from `companySlug` or derived from a custom
 * `companyUrl` (its first sub-domain label). A single fetch error, an unknown
 * tenant (HTTP 400/404), or a malformed payload degrades to an empty/partial
 * result rather than throwing, so a single tenant never nukes a batch run. The
 * credentialed `/api/v1/jobs` private API is deliberately not used.
 */
@SourcePlugin({
  site: Site.NICEBOARD,
  name: 'Niceboard',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class NiceboardService implements IScraper {
  private readonly logger = new Logger(NiceboardService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug && !input.companyUrl) {
      this.logger.warn('No companySlug or companyUrl provided for Niceboard scraper');
      return new JobResponseDto([]);
    }

    const board = this.resolveBoard(companySlug, input.companyUrl);
    if (!board) {
      this.logger.warn('Could not resolve a Niceboard tenant board from input');
      return new JobResponseDto([]);
    }
    const host = NICEBOARD_HOST_TEMPLATE.replace('{board}', encodeURIComponent(board));
    const companyName = this.deriveCompanyName(board);

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(NICEBOARD_HEADERS);

    const resultsWanted = input.resultsWanted ?? NICEBOARD_DEFAULT_RESULTS;
    const seen = new Set<string>();
    const jobPosts: JobPostDto[] = [];

    try {
      this.logger.log(`Fetching Niceboard jobs for board: ${board}`);

      // First page → jobs + true total count for the tenant.
      const first = await this.fetchPage(client, host, 1);
      this.collect(first.jobs, host, companyName, input.descriptionFormat, seen, jobPosts);

      const total = Math.min(first.count || jobPosts.length, resultsWanted);

      if (jobPosts.length < total && first.jobs.length === NICEBOARD_PAGE_SIZE) {
        const pages: number[] = [];
        for (let page = 2; (page - 1) * NICEBOARD_PAGE_SIZE < total; page += 1) {
          pages.push(page);
        }

        // Bounded concurrent fan-out over the remaining pages.
        for (let i = 0; i < pages.length; i += NICEBOARD_MAX_CONCURRENCY) {
          const chunk = pages.slice(i, i + NICEBOARD_MAX_CONCURRENCY);
          const settled = await Promise.allSettled(
            chunk.map((page) => this.fetchPage(client, host, page)),
          );
          for (const result of settled) {
            if (result.status === 'fulfilled') {
              this.collect(
                result.value.jobs,
                host,
                companyName,
                input.descriptionFormat,
                seen,
                jobPosts,
              );
            } else {
              this.logger.warn(`Niceboard page fetch failed: ${result.reason?.message ?? result.reason}`);
            }
          }
          if (i + NICEBOARD_MAX_CONCURRENCY < pages.length) {
            await randomSleep(NICEBOARD_REQUEST_DELAY_MS, NICEBOARD_REQUEST_DELAY_MS * 2);
          }
        }
      }

      const trimmed = jobPosts.slice(0, resultsWanted);
      this.logger.log(`Niceboard total: ${trimmed.length} jobs for ${companyName}`);
      return new JobResponseDto(trimmed);
    } catch (err: any) {
      this.logger.error(`Niceboard scrape error for ${board}: ${err.message}`);
      return new JobResponseDto(jobPosts.slice(0, resultsWanted)); // partial results
    }
  }

  /** Fetch one search page; returns its jobs and the tenant total count. */
  private async fetchPage(
    client: ReturnType<typeof createHttpClient>,
    host: string,
    page: number,
  ): Promise<{ jobs: NiceboardJob[]; count: number }> {
    const url = `${host}${NICEBOARD_JOBS_PATH}`;
    try {
      const response = await client.get<NiceboardJobsResponse>(url, {
        params: {
          ...NICEBOARD_BASE_PARAMS,
          limit: String(NICEBOARD_PAGE_SIZE),
          page: String(page),
        },
      });
      const data = response.data ?? {};
      return {
        jobs: Array.isArray(data.jobs) ? data.jobs : [],
        count: data.count ?? 0,
      };
    } catch (err: any) {
      // An unknown / dead board returns HTTP 400/404; treat that as "no jobs"
      // rather than a hard failure.
      const status = err?.response?.status;
      if (status === 400 || status === 404) {
        this.logger.warn(`Niceboard board not found (HTTP ${status}) for ${host}`);
        return { jobs: [], count: 0 };
      }
      throw err;
    }
  }

  /** Map raw jobs → JobPostDto, de-duplicating by ATS id within this run. */
  private collect(
    jobs: NiceboardJob[],
    host: string,
    companyName: string,
    format: DescriptionFormat | undefined,
    seen: Set<string>,
    out: JobPostDto[],
  ): void {
    for (const job of jobs) {
      try {
        const post = this.processJob(job, host, companyName, format);
        if (!post) continue;
        // processJob guarantees a non-empty atsId (returns null otherwise).
        const key = post.atsId as string;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(post);
      } catch (err: any) {
        this.logger.warn(`Error processing Niceboard job ${job?.id ?? job?.uid}: ${err.message}`);
      }
    }
  }

  private processJob(
    job: NiceboardJob,
    host: string,
    companyName: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const title = job.title ?? job.jobTitle;
    if (!title) return null;

    const atsId = String(job.id ?? '');
    if (!atsId) return null;

    const jobUrl = this.buildJobUrl(host, job, atsId);
    const applyUrl = this.buildApplyUrl(job) ?? jobUrl;

    const rawDescription = job.description_html ?? job.descriptionHtml ?? null;
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

    const department = job.category?.name ?? job.jobtype?.name ?? null;

    return new JobPostDto({
      id: `niceboard-${atsId}`,
      title,
      companyName: job.company_name ?? job.company?.name ?? companyName,
      jobUrl,
      location: this.extractLocation(job),
      description,
      datePosted: this.parseDate(job.published_at ?? job.publishedAt ?? job.created_at),
      isRemote: this.detectRemote(job),
      emails: this.buildEmails(job, description),
      site: Site.NICEBOARD,
      atsId,
      atsType: 'niceboard',
      department,
      applyUrl,
    });
  }

  /** Resolve the board sub-domain label from an explicit slug or a custom URL. */
  private resolveBoard(companySlug: string | undefined, companyUrl: string | undefined): string {
    if (companySlug && companySlug.trim()) return companySlug.trim();
    if (companyUrl) {
      try {
        const u = new URL(companyUrl);
        const host = u.host.split(':')[0];
        const labels = host.split('.').filter(Boolean);
        // For `{board}.niceboard.co` the board is the first label; for a custom
        // domain we still fall back to the first sub-domain label.
        const label = labels[0];
        if (label && label !== 'www') return label;
      } catch {
        // Malformed URL — no board recoverable.
      }
    }
    return '';
  }

  /** Build the public job-detail page URL for the tenant. */
  private buildJobUrl(host: string, job: NiceboardJob, atsId: string): string {
    const slug = job.slug ?? '';
    const companySlug = job.company_slug ?? job.company?.slug ?? '';
    let path: string;
    if (job.anonymity_enabled || !companySlug) {
      path = NICEBOARD_JOB_PAGE_ANON_TEMPLATE.replace('{id}', encodeURIComponent(atsId)).replace(
        '{slug}',
        encodeURIComponent(slug),
      );
    } else {
      path = NICEBOARD_JOB_PAGE_TEMPLATE.replace('{id}', encodeURIComponent(atsId))
        .replace('{slug}', encodeURIComponent(slug))
        .replace('{companySlug}', encodeURIComponent(companySlug));
    }
    return `${host}${path}`;
  }

  /** External apply URL when the role routes off-board; null otherwise. */
  private buildApplyUrl(job: NiceboardJob): string | null {
    if (job.apply_url && job.apply_url.trim()) return job.apply_url.trim();
    return null;
  }

  /**
   * Application emails: the tenant's `apply_email` (when the role applies by
   * email rather than an off-board URL) unioned with any addresses found in the
   * description. The address is carried here, not as a `mailto:` `applyUrl`.
   */
  private buildEmails(job: NiceboardJob, description: string | null): string[] | null {
    const bodyEmails = extractEmails(description) ?? [];
    const applyEmail = job.apply_email?.trim();
    const merged =
      applyEmail && !bodyEmails.includes(applyEmail)
        ? [applyEmail, ...bodyEmails]
        : bodyEmails;
    return merged.length > 0 ? merged : null;
  }

  private deriveCompanyName(board: string): string {
    return board
      .replace(/[-_]+/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /** Prefer the structured `location` object; fall back to free-text `location_name`. */
  private extractLocation(job: NiceboardJob): LocationDto | null {
    const loc = job.location;
    if (loc && typeof loc === 'object') {
      const city = loc.city_long ?? loc.city_short ?? null;
      const state = loc.state_long ?? loc.state_short ?? null;
      const country = loc.country_long ?? loc.country_short ?? null;
      if (city || state || country) {
        return new LocationDto({ city, state, country });
      }
      if (loc.name && loc.name.trim()) {
        return this.locationFromLabel(loc.name);
      }
    }
    if (typeof job.location_name === 'string' && job.location_name.trim()) {
      return this.locationFromLabel(job.location_name);
    }
    return null;
  }

  /** Split a free-text "City, State, Country" label into a LocationDto. */
  private locationFromLabel(label: string): LocationDto | null {
    const parts = label
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length === 0) return null;
    if (parts.length === 1) {
      return new LocationDto({ city: parts[0], state: null, country: null });
    }
    const city = parts[0];
    const state = parts.length >= 3 ? parts[1] : parts[parts.length - 1];
    const country = parts.length >= 3 ? parts[parts.length - 1] : null;
    return new LocationDto({ city: city ?? null, state: state ?? null, country: country ?? null });
  }

  /** Detect remote roles from the explicit flags or the title. */
  private detectRemote(job: NiceboardJob): boolean {
    if (job.is_remote === true || job.remote_only === true) return true;
    const haystacks = [job.remote_required_location, job.title ?? job.jobTitle];
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
