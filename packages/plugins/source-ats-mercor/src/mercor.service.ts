import { Injectable, Logger } from '@nestjs/common';
import { SourcePlugin } from '@ever-jobs/plugin';
import {
  classifyScrapeError,
  CompensationDto,
  CompensationInterval,
  IScraper,
  JobPostDto,
  JobResponseDto,
  LocationDto,
  ScraperInputDto,
  Site,
} from '@ever-jobs/models';
import { createHttpClient } from '@ever-jobs/common';
import {
  MERCOR_API_BASE_URL,
  MERCOR_DEFAULT_RESULTS_WANTED,
  MERCOR_ERR_ENVELOPE,
  MERCOR_ERR_FETCH_FAILED,
  MERCOR_EXPLORE_PATH,
  MERCOR_HEADERS,
  MERCOR_PUBLIC_ORIGIN,
} from './mercor.constants';
import { MercorListing, MercorListingsResponse } from './mercor.types';

/**
 * Spec 013 / T05 — Mercor catalogue-wide explore-page scraper.
 *
 * Mercor is a talent marketplace, not a per-company ATS. The
 * upstream `https://aws.api.mercor.com/work/listings-explore-page`
 * endpoint returns the ENTIRE public catalogue in a single GET — no
 * per-company URL segmentation, no pagination, no slug-keyed
 * dispatch.
 *
 * Input semantics (Spec 013 / Q-029 / FR-5..FR-8):
 *   - **Empty `companySlug`** ⇒ full catalogue, capped by
 *     `resultsWanted` (default 100).
 *   - **Populated `companySlug`** ⇒ post-filter `listings[]` by
 *     case-insensitive substring match on `companyName`. The cap
 *     applies AFTER the filter so a 5-row Stripe slice is genuinely
 *     5 rows, not "first 5 of all 200 listings".
 *
 * Wire format mirrors upstream Python
 * (`OTHERS/Ats-scrapers/mercor/api_client.py`):
 *   - Single GET to
 *     `https://aws.api.mercor.com/work/listings-explore-page`.
 *   - Headers include the literal `Authorization: Bearer` (empty
 *     token) string per FR-8.
 *   - `Origin: https://work.mercor.com` + matching `Referer` —
 *     the API gateway rejects requests without the public origin
 *     pair.
 *
 * Job URL composition: `https://work.mercor.com/jobs/<listingId>/<title-slug>`
 * — same shape upstream Python's `construct_job_url` produces. The
 * slug is a best-effort kebab-case of the title; downstream consumers
 * use `listingId` for stable identity, the slug is decorative.
 *
 * Error handling (FR-12 / `AGENTS.md §10`):
 *   - HTTP failure → empty `JobResponseDto` with sentinel
 *     `ERR_MERCOR_FETCH_FAILED` logged.
 *   - Response missing `listings[]` → empty `JobResponseDto` with
 *     sentinel `ERR_MERCOR_ENVELOPE` logged.
 *   - Both branches resolve normally — never re-thrown.
 */
@SourcePlugin({
  site: Site.MERCOR,
  name: 'Mercor',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class MercorService implements IScraper {
  private readonly logger = new Logger(MercorService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const resultsWanted =
      input.resultsWanted ?? MERCOR_DEFAULT_RESULTS_WANTED;
    const slugFilter = input.companySlug?.trim().toLowerCase() ?? '';

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      requestTimeout: input.requestTimeout,
    });
    client.setHeaders(MERCOR_HEADERS);

    const url = `${MERCOR_API_BASE_URL}${MERCOR_EXPLORE_PATH}`;

    let payload: MercorListingsResponse;
    try {
      const response = await client.get<MercorListingsResponse>(url);
      payload = (response.data ?? {}) as MercorListingsResponse;
    } catch (err: any) {
      const status = err?.response?.status;
      this.logger.warn(
        `MercorService: ${MERCOR_ERR_FETCH_FAILED} — explore-page fetch failed (status=${status ?? 'n/a'}): ${err?.message ?? err}`,
      );
      return new JobResponseDto([], classifyScrapeError(err));
    }

    if (!Array.isArray(payload.listings)) {
      this.logger.warn(
        `MercorService: ${MERCOR_ERR_ENVELOPE} — response missing listings[] array`,
      );
      return new JobResponseDto([]);
    }

    const filtered = slugFilter
      ? payload.listings.filter((l) =>
          (l.companyName ?? '').toLowerCase().includes(slugFilter),
        )
      : payload.listings;

    const capped = filtered.slice(0, resultsWanted);
    const jobs: JobPostDto[] = capped.map((l) => this.toJobPost(l));

    this.logger.log(
      `MercorService: ${jobs.length} jobs (slug=${slugFilter || '<none>'}, totalListings=${payload.listings.length}, resultsWanted=${resultsWanted})`,
    );
    return new JobResponseDto(jobs);
  }

  /** Map a single explore-page listing into the canonical `JobPostDto`. */
  private toJobPost(listing: MercorListing): JobPostDto {
    const location = listing.location
      ? new LocationDto({ city: listing.location })
      : null;
    const isRemote =
      listing.location?.toLowerCase().includes('remote') ?? false;

    const compensation = this.toCompensation(listing);

    return new JobPostDto({
      id: `mercor-${listing.listingId}`,
      title: listing.title,
      companyName: listing.companyName ?? 'Mercor',
      jobUrl: this.buildJobUrl(listing),
      location,
      isRemote,
      site: Site.MERCOR,
      atsId: listing.listingId,
      atsType: 'mercor',
      datePosted: listing.postedAt ?? null,
      compensation,
    });
  }

  /**
   * Build the `https://work.mercor.com/jobs/<listingId>/<title-slug>`
   * URL — same shape upstream Python's `construct_job_url`.
   */
  private buildJobUrl(listing: MercorListing): string {
    const slug = this.slugify(listing.title);
    return `${MERCOR_PUBLIC_ORIGIN}/jobs/${listing.listingId}/${slug}`;
  }

  /** Convert a title to a kebab-case slug (alphanumerics + hyphens). */
  private slugify(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^\w\s-]/g, '')
      .replace(/[\s_]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  /**
   * Map upstream's `rateMin / rateMax / payRateFrequency` triple into a
   * `CompensationDto`. Returns `null` when no rate is present so
   * downstream consumers can rely on the absence-of-data signal
   * rather than synthesising zero-bound entries.
   */
  private toCompensation(
    listing: MercorListing,
  ): CompensationDto | null {
    if (
      listing.rateMin == null &&
      listing.rateMax == null
    ) {
      return null;
    }
    const interval = this.toInterval(listing.payRateFrequency);
    return new CompensationDto({
      interval,
      minAmount: listing.rateMin ?? null,
      maxAmount: listing.rateMax ?? null,
      currency: 'USD',
    });
  }

  /**
   * Map upstream's lowercase frequency string to the canonical
   * `CompensationInterval` enum. Defaults to `HOURLY` when missing —
   * matches Mercor's marketplace default for unspecified rates.
   */
  private toInterval(
    freq: string | null | undefined,
  ): CompensationInterval {
    switch ((freq ?? '').toLowerCase()) {
      case 'yearly':
      case 'annual':
        return CompensationInterval.YEARLY;
      case 'monthly':
        return CompensationInterval.MONTHLY;
      case 'weekly':
        return CompensationInterval.WEEKLY;
      case 'hourly':
      default:
        return CompensationInterval.HOURLY;
    }
  }
}
