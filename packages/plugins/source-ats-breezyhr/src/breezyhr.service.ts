import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  IScraper,
  ScraperInputDto,
  JobResponseDto,
  JobPostDto,
  Site,
  LocationDto,
  DescriptionFormat,
  getJobTypeFromString,
  classifyScrapeError,
  ScrapeDiagnostics,
} from '@ever-jobs/models';
import {
  createHttpClient,
  htmlToPlainText,
  jobPostingLdToCompensation,
  markdownConverter,
  parseJobPostingLd,
  parseLocationList,
  resolveCompensation,
} from '@ever-jobs/common';

import {
  BREEZYHR_DETAIL_CONCURRENCY,
  breezyDetailUrl,
  breezyListUrl,
} from './breezyhr.constants';
import { BreezyDetail, BreezyJob, BreezyLocation } from './breezyhr.types';

@SourcePlugin({
  site: Site.BREEZYHR,
  name: 'BreezyHR',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class BreezyHRService implements IScraper {
  private readonly logger = new Logger(BreezyHRService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const company = input.companySlug;
    if (!company) {
      this.logger.warn('No companySlug provided for Breezy HR scraper');
      return new JobResponseDto([]);
    }

    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 100;
    let diagnostics: ScrapeDiagnostics | undefined;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = breezyListUrl(company);
      this.logger.log(`BreezyHR: fetching ${url}`);

      const { data } = await client.get<BreezyJob[]>(url);
      const listings = (Array.isArray(data) ? data : []).slice(0, resultsWanted);

      // The list endpoint omits the posting body and structured pay; overlay
      // each job with its public detail page (ld+json) before mapping.
      const details = await this.fetchDetails(client, listings, company);

      listings.forEach((listing, index) => {
        try {
          const post = this.processJob(
            listing,
            company,
            details[index],
            input.descriptionFormat,
          );
          if (post) jobs.push(post);
        } catch (err: any) {
          this.logger.warn(
            `Error processing BreezyHR job ${listing.friendly_id ?? listing.id}: ${err.message}`,
          );
        }
      });

      this.logger.log(`BreezyHR: scraped ${jobs.length} jobs for ${company}`);
    } catch (err: any) {
      this.logger.error(`BreezyHR scrape failed for ${company}: ${err.message}`);
      diagnostics = classifyScrapeError(err);
    }

    return new JobResponseDto(jobs, jobs.length ? undefined : diagnostics);
  }

  private processJob(
    listing: BreezyJob,
    company: string,
    detail: BreezyDetail | null | undefined,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const title = listing.name ?? listing.title ?? '';
    if (!title) return null;

    const jobId = listing.id ?? listing.friendly_id ?? '';
    const id = `breezyhr-${company}-${jobId}`;

    const parsedLocations = parseLocationList(this.locationLabels(listing));
    const location =
      parsedLocations.location ?? this.fallbackLocation(listing.location);

    const isRemote =
      (listing.location?.is_remote ?? false) || parsedLocations.remoteMentioned;

    const description = this.formatDescription(detail?.description, format);

    // The list record carries the human-readable display name under
    // `company.name`; the slug is only a last resort.
    const companyName = listing.company?.name?.trim() || company;

    // Structured-first: the detail ld+json `baseSalary` is authoritative; the
    // free-text list `salary` is the fallback (Spec 5018 precedence).
    const structured = jobPostingLdToCompensation(detail?.baseSalary);
    const compensation = resolveCompensation({
      structured,
      text: listing.salary,
    });
    const salarySource = structured
      ? 'structured'
      : compensation
        ? 'description'
        : null;

    const employmentType = listing.type?.name?.trim() || null;
    const jobTypeKey = listing.type?.id ?? listing.type?.name ?? null;
    const mappedJobType = jobTypeKey ? getJobTypeFromString(jobTypeKey) : null;

    return new JobPostDto({
      id,
      site: Site.BREEZYHR,
      title,
      companyName,
      jobUrl:
        listing.url ??
        `https://${company}.breezy.hr/p/${listing.friendly_id ?? jobId}`,
      location,
      description,
      ...(compensation ? { compensation, salarySource } : {}),
      datePosted: listing.published_date ?? listing.creation_date ?? null,
      isRemote,
      ...(mappedJobType ? { jobType: [mappedJobType] } : {}),
      department: listing.department ?? listing.category?.name ?? null,
      ...(employmentType ? { employmentType } : {}),
      atsId: jobId,
      atsType: 'breezyhr',
    });
  }

  /**
   * Fetch each job's detail page under bounded concurrency and parse the
   * schema.org `JobPosting` (description + structured `baseSalary`) out of it.
   * Fail-safe: a failed fetch or an unparseable page yields `null` for that job
   * (the batch is never nuked).
   */
  private async fetchDetails(
    client: ReturnType<typeof createHttpClient>,
    listings: BreezyJob[],
    company: string,
  ): Promise<(BreezyDetail | null)[]> {
    const details: (BreezyDetail | null)[] = new Array(listings.length).fill(
      null,
    );

    for (
      let index = 0;
      index < listings.length;
      index += BREEZYHR_DETAIL_CONCURRENCY
    ) {
      const batch = listings.slice(index, index + BREEZYHR_DETAIL_CONCURRENCY);
      const settled = await Promise.allSettled(
        batch.map((listing) => this.fetchDetail(client, listing, company)),
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
    listing: BreezyJob,
    company: string,
  ): Promise<BreezyDetail | null> {
    const friendlyId = listing.friendly_id ?? listing.id;
    if (!friendlyId) return null;

    try {
      const { data } = await client.get<string>(
        breezyDetailUrl(company, friendlyId),
        { responseType: 'text' },
      );
      if (typeof data !== 'string') return null;
      const posting = parseJobPostingLd(data).find(
        (p) =>
          (p.description && p.description.trim().length > 0) ||
          p.baseSalary != null,
      );
      if (!posting) return null;
      return {
        description: posting.description ?? null,
        baseSalary: posting.baseSalary ?? null,
      };
    } catch (err: any) {
      this.logger.warn(
        `BreezyHR: detail fetch failed for ${company}/${friendlyId}: ${err.message}`,
      );
      return null;
    }
  }

  private formatDescription(
    html: string | null | undefined,
    format?: DescriptionFormat,
  ): string | null {
    if (!html || !html.trim()) return null;
    if (format === DescriptionFormat.HTML) return html;
    if (format === DescriptionFormat.PLAIN) return htmlToPlainText(html);
    return markdownConverter(html) ?? html;
  }

  /** Build location labels from the structured list fields for the parser. */
  private locationLabels(listing: BreezyJob): string[] {
    const nodes: BreezyLocation[] =
      listing.locations && listing.locations.length > 0
        ? listing.locations
        : listing.location
          ? [listing.location]
          : [];

    const labels: string[] = [];
    for (const node of nodes) {
      const parts = [node.city, this.nodeName(node.state), this.nodeName(node.country)]
        .map((part) => part?.trim())
        .filter((part): part is string => !!part);
      const label = parts.length > 0 ? parts.join(', ') : node.name?.trim();
      if (label) labels.push(label);
    }
    return labels;
  }

  /** A Breezy state/country node may be an object `{id,name}` or a string. */
  private nodeName(
    node: { name?: string | null } | string | null | undefined,
  ): string | null {
    if (!node) return null;
    if (typeof node === 'string') return node;
    return node.name ?? null;
  }

  /** Last-resort location when the parser yields nothing. */
  private fallbackLocation(
    loc: BreezyLocation | null | undefined,
  ): LocationDto | null {
    if (!loc) return null;
    const city = loc.city ?? null;
    const state = this.nodeName(loc.state);
    const country = this.nodeName(loc.country);
    if (!city && !state && !country) {
      return loc.name ? new LocationDto({ city: loc.name }) : null;
    }
    return new LocationDto({ city, state, country });
  }
}
