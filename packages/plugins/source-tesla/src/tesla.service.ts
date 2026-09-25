import { Injectable, Logger } from '@nestjs/common';
import { SourcePlugin } from '@ever-jobs/plugin';
import {
  IScraper,
  JobPostDto,
  JobResponseDto,
  LocationDto,
  ScraperInputDto,
  Site,
} from '@ever-jobs/models';
import { createHttpClient, parseLocationList } from '@ever-jobs/common';
import {
  TESLA_AKAMAI_STATUS_CODES,
  TESLA_BASE_URL,
  TESLA_BOARD_PATH,
  TESLA_DEFAULT_DESCRIPTION_DEPTH,
  TESLA_DEFAULT_RESULTS_WANTED,
  TESLA_DESCRIPTION_BUDGET,
  TESLA_DETAIL_PATH_TEMPLATE,
  TESLA_ERR_AKAMAI_CHALLENGE,
  TESLA_ERR_FETCH_FAILED,
  TESLA_HEADERS,
  TESLA_PUBLIC_JOB_BASE,
} from './tesla.constants';
import {
  TeslaBoardListing,
  TeslaBoardLookup,
  TeslaBoardResponse,
  TeslaJobDetail,
} from './tesla.types';

/**
 * Spec 013 / T07 — Tesla single-tenant pure-HTTP scraper.
 *
 * Tesla is a single-tenant scraper — `companyUrl` and `companySlug`
 * inputs are ignored. The board endpoint
 * `https://www.tesla.com/cua-api/apps/careers/state` returns the
 * entire current job catalogue in one GET; per-job description
 * population requires follow-up GETs to `/cua-api/careers/job/{id}`,
 * budgeted by `input.descriptionDepth` per Q-031 / FR-11:
 *
 *   - `'board'` (0 follow-ups) — descriptions stay null.
 *   - `'detail-25'` (default; 25 follow-ups) — first 25 jobs (by
 *     board-emit order) get descriptions, remainder stay null.
 *   - `'detail-all'` (∞ follow-ups) — every job gets a description;
 *     opt-in only because it busts NFR-2's 12 s ceiling.
 *
 * Akamai handling (FR-12):
 *   - Board GET returning HTTP 403 / 503 → empty `JobResponseDto`
 *     with sentinel `ERR_TESLA_AKAMAI_CHALLENGE` logged.
 *   - Board GET returning a body that is NOT a JSON object
 *     (typically an HTML challenge page) → same sentinel.
 *   - Other HTTP failures → `ERR_TESLA_FETCH_FAILED` sentinel
 *     (added during implementation; symmetric with the Mercor /
 *     Oracle two-sentinel pattern).
 *   - Detail-fetch failures are SILENTLY swallowed (logged at
 *     `debug`) — the corresponding listing keeps `description: null`
 *     but still emits as a `JobPostDto`. We do not let one bad
 *     detail-page poison the whole catalogue.
 *
 * **HTTP-only by design.** Playwright support lives in the OPTIONAL
 * companion package `@ever-jobs/source-tesla-playwright`. No
 * `playwright` import in this file, period.
 */
@SourcePlugin({
  site: Site.TESLA,
  name: 'Tesla',
  category: 'company',
  isAts: false,
})
@Injectable()
export class TeslaService implements IScraper {
  private readonly logger = new Logger(TeslaService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const resultsWanted =
      input.resultsWanted ?? TESLA_DEFAULT_RESULTS_WANTED;
    const depthKey = this.resolveDepth(input.descriptionDepth);
    const detailBudget = TESLA_DESCRIPTION_BUDGET[depthKey];

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      requestTimeout: input.requestTimeout,
    });
    client.setHeaders(TESLA_HEADERS);

    const board = await this.fetchBoard(client);
    if (board === null) {
      return new JobResponseDto([]);
    }

    const listings = (board.listings ?? []).slice(0, resultsWanted);
    const lookup = board.lookup ?? {};

    const detailFetchCount = Math.min(
      listings.length,
      Number.isFinite(detailBudget) ? detailBudget : listings.length,
    );

    const jobs: JobPostDto[] = [];
    for (let i = 0; i < listings.length; i++) {
      const listing = listings[i];
      const description =
        i < detailFetchCount
          ? await this.fetchDetail(client, listing.id)
          : null;
      jobs.push(this.toJobPost(listing, lookup, description));
    }

    this.logger.log(
      `TeslaService: ${jobs.length} jobs (descriptionDepth=${depthKey}, detailFetched=${detailFetchCount}, resultsWanted=${resultsWanted})`,
    );
    return new JobResponseDto(jobs);
  }

  /**
   * Resolve `input.descriptionDepth` against the documented enum,
   * defaulting to `'detail-25'` per Q-031 when undefined or invalid.
   */
  private resolveDepth(raw: string | undefined): string {
    if (raw && raw in TESLA_DESCRIPTION_BUDGET) {
      return raw;
    }
    return TESLA_DEFAULT_DESCRIPTION_DEPTH;
  }

  /**
   * Fetch the board endpoint. Returns the parsed envelope on success,
   * `null` on any failure (sentinel logged via `Logger.warn`).
   */
  private async fetchBoard(client: any): Promise<TeslaBoardResponse | null> {
    const url = `${TESLA_BASE_URL}${TESLA_BOARD_PATH}`;
    try {
      const response = await client.get(url);
      const data = response?.data;

      if (this.looksLikeAkamaiHtml(data)) {
        this.logger.warn(
          `TeslaService: ${TESLA_ERR_AKAMAI_CHALLENGE} — board returned HTML body (Akamai challenge)`,
        );
        return null;
      }

      return (data ?? {}) as TeslaBoardResponse;
    } catch (err: any) {
      const status = err?.response?.status;
      if (status && TESLA_AKAMAI_STATUS_CODES.has(status)) {
        this.logger.warn(
          `TeslaService: ${TESLA_ERR_AKAMAI_CHALLENGE} — board returned HTTP ${status}`,
        );
      } else {
        this.logger.warn(
          `TeslaService: ${TESLA_ERR_FETCH_FAILED} — board fetch failed (status=${status ?? 'n/a'}): ${err?.message ?? err}`,
        );
      }
      return null;
    }
  }

  /**
   * Fetch a single job's detail envelope. Failures are swallowed and
   * surface as `description: null` on the corresponding listing —
   * we don't let a single bad detail page poison the whole batch.
   */
  private async fetchDetail(
    client: any,
    jobId: string,
  ): Promise<string | null> {
    const url = `${TESLA_BASE_URL}${TESLA_DETAIL_PATH_TEMPLATE.replace('{id}', jobId)}`;
    try {
      const response = await client.get(url);
      const detail = (response?.data ?? {}) as TeslaJobDetail;
      return this.composeDescription(detail);
    } catch (err: any) {
      this.logger.debug(
        `TeslaService: detail fetch failed for jobId=${jobId} (status=${err?.response?.status ?? 'n/a'}); description left null`,
      );
      return null;
    }
  }

  /**
   * Build the canonical `description` string by concatenating the four
   * documented detail fields with `\n\n` separators (matches upstream
   * Python's join pattern). Returns `null` when none of the fields
   * are populated — distinguishes "we tried but no description"
   * from "we never tried".
   */
  private composeDescription(detail: TeslaJobDetail): string | null {
    const parts: string[] = [];
    if (detail.jobDescription) {
      parts.push(`Description:\n${detail.jobDescription}`);
    }
    if (detail.jobResponsibilities) {
      parts.push(`Responsibilities:\n${detail.jobResponsibilities}`);
    }
    if (detail.jobRequirements) {
      parts.push(`Requirements:\n${detail.jobRequirements}`);
    }
    if (detail.jobCompensationAndBenefits) {
      parts.push(`Compensation & Benefits:\n${detail.jobCompensationAndBenefits}`);
    }
    return parts.length > 0 ? parts.join('\n\n') : null;
  }

  /**
   * Heuristic Akamai-challenge detector. Tesla's gateway sometimes
   * returns HTTP 200 with an HTML body when its bot manager flags a
   * client — we treat any non-object payload OR any payload whose
   * top-level shape lacks `listings` AND `lookup` as "not the
   * expected JSON envelope".
   */
  private looksLikeAkamaiHtml(data: any): boolean {
    if (typeof data === 'string') return true;
    if (data == null) return false;
    if (typeof data !== 'object') return true;
    const hasListings = 'listings' in data;
    const hasLookup = 'lookup' in data;
    return !hasListings && !hasLookup;
  }

  /** Map a single board listing into the canonical `JobPostDto`. */
  private toJobPost(
    listing: TeslaBoardListing,
    lookup: TeslaBoardLookup,
    description: string | null,
  ): JobPostDto {
    const locationStr = lookup.locations?.[listing.l ?? ''] ?? null;
    const departmentStr = lookup.departments?.[listing.d ?? ''] ?? null;

    const locationParsed = parseLocationList([locationStr]);
    const location = locationStr ? locationParsed.location : null;
    const isRemote =
      locationStr?.toLowerCase().includes('remote') ?? false;

    return new JobPostDto({
      id: `tesla-${listing.id}`,
      title: listing.t,
      companyName: 'Tesla',
      jobUrl: this.buildJobUrl(listing.id, listing.t),
      location,
      ...(locationParsed.locations.length > 0 ? { locations: locationParsed.locations } : {}),
      isRemote,
      site: Site.TESLA,
      atsId: listing.id,
      atsType: 'tesla',
      department: departmentStr,
      description,
    });
  }

  /**
   * Build the public-facing careers URL:
   * `https://www.tesla.com/careers/search/job/<title-slug>-<id>`.
   * Matches upstream Python's `create_job_url_slug()`.
   */
  private buildJobUrl(jobId: string, title: string): string {
    const slug = this.slugify(title);
    return `${TESLA_PUBLIC_JOB_BASE}/${slug}-${jobId}`;
  }

  /** Convert a title to a kebab-case slug (alphanumerics + hyphens). */
  private slugify(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }
}
