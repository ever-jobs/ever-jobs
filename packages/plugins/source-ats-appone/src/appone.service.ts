import { Injectable, Logger } from '@nestjs/common';
import { SourcePlugin } from '@ever-jobs/plugin';
import {
  IScraper,
  JobPostDto,
  JobResponseDto,
  LocationDto,
  ScraperInputDto,
  Site,
  getJobTypeFromString,
} from '@ever-jobs/models';
import {
  createHttpClient,
  extractEmails,
  resolveCompensation,
} from '@ever-jobs/common';
import {
  APPONE_DEFAULT_RESULTS_WANTED,
  APPONE_DETAIL_CONCURRENCY,
  APPONE_HEADERS,
  APPONE_LIST_BASE_URL,
  apponeDetailEndpoint,
  apponeListEndpoint,
} from './appone.constants';
import {
  ApponeCompanyJobPosts,
  ApponeJobPost,
  ApponeJobPosting,
} from './appone.types';

/**
 * Spec 5036 — AppOne (Paychex-owned) JSON REST implementation.
 *
 * AppOne is the same vendor family as `source-ats-paychex` but a distinct
 * technical surface: the paychex plugin scrapes `applybypaychex.com` via
 * `sitemap.xml` + prerendered JSON-LD, whereas AppOne is an Angular SPA backed
 * by two unauthenticated JSON endpoints. It therefore warrants its own plugin
 * (the surfaces share no crawlable overlap).
 *
 * List + bounded detail-overlay (the gem/dover pattern):
 *   - `GET companyjobposts/{tenant}` returns every field except the body
 *     (title, location, jobType, workplaceType, datePosted, jobPostUrl) plus
 *     the tenant `companyName`.
 *   - Each kept posting is overlaid with its
 *     `GET jobposting/{jobPostId}` detail for the plain-text `description`.
 *
 * The tenant is `input.companySlug` (the careers-URL slug, e.g.
 * `vansaircraftcareers`) or the last path segment of `input.companyUrl` on
 * `jobs.appone.com`. HTTP errors are caught and surfaced as an empty
 * `JobResponseDto` — the scrape never throws.
 */
@SourcePlugin({
  site: Site.APPONE,
  name: 'AppOne',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class ApponeService implements IScraper {
  private readonly logger = new Logger(ApponeService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const tenant = this.resolveTenant(input);
    if (!tenant) {
      this.logger.warn(
        'AppOne scrape requires `companySlug` or a jobs.appone.com `companyUrl` — unset',
      );
      return new JobResponseDto([]);
    }

    const resultsWanted = input.resultsWanted ?? APPONE_DEFAULT_RESULTS_WANTED;

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(APPONE_HEADERS);

    let listing: ApponeCompanyJobPosts;
    try {
      const response = await client.get<ApponeCompanyJobPosts>(
        apponeListEndpoint(tenant),
      );
      listing = response.data ?? {};
    } catch (err: any) {
      this.logger.warn(
        `AppOne list fetch failed for ${tenant}: ${err.message ?? String(err)}`,
      );
      return new JobResponseDto([]);
    }

    const companyName = listing.companyName?.trim() || tenant;
    const allPosts = listing.jobPosts ?? [];

    // Cap before fetching detail so we only overlay the postings we keep.
    const posts = allPosts
      .filter((post) => post.jobPostId && post.jobTitle?.trim())
      .slice(0, resultsWanted);
    const details = await this.fetchDetails(client, posts);

    const jobs: JobPostDto[] = [];
    posts.forEach((post, index) => {
      const mapped = this.toJobPost(post, companyName, details[index]);
      if (mapped) jobs.push(mapped);
    });

    this.logger.log(
      `AppOne: ${jobs.length} jobs for ${tenant} (resultsWanted=${resultsWanted})`,
    );
    return new JobResponseDto(jobs);
  }

  /** `companySlug`, else the last path segment of a jobs.appone.com URL. */
  private resolveTenant(input: ScraperInputDto): string | null {
    const slug = input.companySlug?.trim();
    if (slug) return slug;
    const url = input.companyUrl?.trim();
    if (!url) return null;
    try {
      const parsed = new URL(url.includes('://') ? url : `https://${url}`);
      const segments = parsed.pathname.split('/').filter(Boolean);
      return segments.length ? decodeURIComponent(segments[segments.length - 1]) : null;
    } catch {
      return null;
    }
  }

  /**
   * Overlay each kept posting with its detail under bounded concurrency. A
   * failed fetch yields `null` for that posting (the batch is never nuked) —
   * the row still ships its list-only fields.
   */
  private async fetchDetails(
    client: ReturnType<typeof createHttpClient>,
    posts: ReadonlyArray<ApponeJobPost>,
  ): Promise<(ApponeJobPosting | null)[]> {
    const details: (ApponeJobPosting | null)[] = new Array(posts.length).fill(
      null,
    );

    for (let index = 0; index < posts.length; index += APPONE_DETAIL_CONCURRENCY) {
      const batch = posts.slice(index, index + APPONE_DETAIL_CONCURRENCY);
      const settled = await Promise.allSettled(
        batch.map((post) => this.fetchDetail(client, post)),
      );
      settled.forEach((result, batchIndex) => {
        if (result.status === 'fulfilled') {
          details[index + batchIndex] = result.value;
        }
      });
    }

    return details;
  }

  private async fetchDetail(
    client: ReturnType<typeof createHttpClient>,
    post: ApponeJobPost,
  ): Promise<ApponeJobPosting | null> {
    const id = post.jobPostId;
    if (!id) return null;
    try {
      const response = await client.get<ApponeJobPosting>(
        apponeDetailEndpoint(id),
      );
      return response.data ?? null;
    } catch (err: any) {
      this.logger.warn(
        `AppOne: detail fetch failed for ${id}: ${err.message ?? String(err)}`,
      );
      return null;
    }
  }

  /**
   * Map a single list posting (+ its overlaid detail) to a canonical
   * `JobPostDto`. Returns `null` when the posting has no usable id (skipped
   * rather than emitted with a synthetic id, which would break downstream
   * dedup keying).
   */
  private toJobPost(
    post: ApponeJobPost,
    companyName: string,
    detail: ApponeJobPosting | null | undefined,
  ): JobPostDto | null {
    const id = post.jobPostId;
    if (!id) return null;
    const title = post.jobTitle?.trim();
    if (!title) return null;

    const workplace = (post.workplaceType ?? detail?.workplaceType ?? '')
      .trim()
      .toUpperCase();
    const locationText = (post.location ?? detail?.location ?? '').trim();
    const location = this.toLocation(locationText);
    const isRemote =
      workplace === 'REMOTE' || locationText.toLowerCase().includes('remote');

    const employmentType = post.jobType?.trim() || detail?.jobType?.trim() || null;
    const mappedJobType = employmentType
      ? getJobTypeFromString(employmentType)
      : null;

    // AppOne serves a plain-text body (newline-separated, not HTML).
    const description = detail?.description?.trim() || null;
    // No structured pay in the payload — parse it from the description text.
    const compensation = resolveCompensation({ text: description });

    const jobUrl =
      post.jobPostUrl?.trim() || `${APPONE_LIST_BASE_URL}/job/${id}`;

    return new JobPostDto({
      id: `appone-${id}`,
      title,
      companyName,
      jobUrl,
      location,
      description,
      emails: extractEmails(description),
      datePosted: this.toDatePosted(post.datePosted),
      isRemote,
      ...(workplace === 'HYBRID' ? { workFromHomeType: 'Hybrid' } : {}),
      site: Site.APPONE,
      atsId: id,
      atsType: 'appone',
      ...(employmentType ? { employmentType } : {}),
      ...(mappedJobType ? { jobType: [mappedJobType] } : {}),
      ...(compensation ? { compensation } : {}),
    });
  }

  /** Split "City, ST" into `{ city, state }`; a lone token becomes `city`. */
  private toLocation(text: string): LocationDto | null {
    if (!text) return null;
    const parts = text.split(',').map((part) => part.trim()).filter(Boolean);
    if (!parts.length) return null;
    const [city, state] = parts;
    return new LocationDto({ city, ...(state ? { state } : {}) });
  }

  /** ISO-8601 `datePosted` → `Date`; `null` when absent or unparseable. */
  private toDatePosted(raw: string | null | undefined): Date | null {
    const value = raw?.trim();
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
}
