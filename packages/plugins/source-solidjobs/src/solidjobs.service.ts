import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper,
  ScraperInputDto,
  JobResponseDto,
  JobPostDto,
  LocationDto,
  CompensationDto,
  JobType,
  Site,
  DescriptionFormat,
  getCompensationInterval,
  getJobTypeFromString,
} from '@ever-jobs/models';
import {
  createHttpClient,
  htmlToPlainText,
  markdownConverter,
  extractEmails,
} from '@ever-jobs/common';
import {
  SOLIDJOBS_API_URL,
  SOLIDJOBS_CAMPAIGN,
  SOLIDJOBS_DEFAULT_DIVISION,
  SOLIDJOBS_DEFAULT_RESULTS,
  SOLIDJOBS_DIVISIONS_ENV,
  SOLIDJOBS_HEADERS,
} from './solidjobs.constants';
import { SolidJobsOffer, SolidJobsResponse } from './solidjobs.types';

@SourcePlugin({
  site: Site.SOLIDJOBS,
  name: 'Solid.Jobs',
  category: 'regional',
})
@Injectable()
export class SolidJobsService implements IScraper {
  private readonly logger = new Logger(SolidJobsService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const resultsWanted = input.resultsWanted ?? SOLIDJOBS_DEFAULT_RESULTS;
    const divisions = this.resolveDivisions();

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(SOLIDJOBS_HEADERS);

    this.logger.log(
      `Fetching Solid.Jobs divisions [${divisions.join(', ')}] (resultsWanted=${resultsWanted})`,
    );

    try {
      const settled = await Promise.allSettled(
        divisions.map((division) => client.get(this.buildDivisionUrl(division))),
      );

      const offers: SolidJobsOffer[] = [];
      settled.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          const data: SolidJobsResponse | undefined = result.value?.data;
          if (data && Array.isArray(data.jobs)) {
            this.logger.log(
              `Solid.Jobs division "${divisions[index]}" returned ${data.jobs.length} offers`,
            );
            offers.push(...data.jobs);
          } else {
            this.logger.warn(
              `Solid.Jobs division "${divisions[index]}" returned an empty or invalid payload`,
            );
          }
        } else {
          this.logger.error(
            `Solid.Jobs division "${divisions[index]}" request failed: ${
              result.reason?.message ?? result.reason
            }`,
          );
        }
      });

      const jobs: JobPostDto[] = [];

      for (const offer of offers) {
        if (jobs.length >= resultsWanted) break;

        try {
          if (input.searchTerm && !this.matchesSearch(offer, input.searchTerm)) {
            continue;
          }

          const job = this.mapJob(offer, input.descriptionFormat);
          if (job) {
            jobs.push(job);
          } else {
            this.logger.warn(
              `Skipping malformed Solid.Jobs offer ${
                offer?.jobOfferKey ?? '(no jobOfferKey)'
              }: missing jobOfferKey, title or url`,
            );
          }
        } catch (err: any) {
          this.logger.warn(
            `Error mapping Solid.Jobs offer ${offer?.jobOfferKey}: ${err.message}`,
          );
        }
      }

      this.logger.log(`Solid.Jobs returned ${jobs.length} jobs`);
      return new JobResponseDto(jobs);
    } catch (err: any) {
      this.logger.error(`Solid.Jobs scrape error: ${err.message}`);
      return new JobResponseDto([], classifyScrapeError(err));
    }
  }

  /**
   * Resolve the division list: comma-separated SOLIDJOBS_DIVISIONS env
   * override, falling back to the default `it` division.
   */
  private resolveDivisions(): string[] {
    const raw = process.env[SOLIDJOBS_DIVISIONS_ENV];
    if (raw) {
      const divisions = raw
        .split(',')
        .map((d) => d.trim().toLowerCase())
        .filter((d) => d.length > 0);
      if (divisions.length > 0) return divisions;
    }
    return [SOLIDJOBS_DEFAULT_DIVISION];
  }

  /**
   * Build the per-division offers URL. The `campaign` query parameter is
   * mandatory — the server rejects requests without it (HTTP 400).
   */
  private buildDivisionUrl(division: string): string {
    return `${SOLIDJOBS_API_URL}/${encodeURIComponent(division)}?campaign=${SOLIDJOBS_CAMPAIGN}`;
  }

  /**
   * Check whether an offer matches the given search term
   * (case-insensitive across title, category, subCategory and skill names).
   */
  private matchesSearch(offer: SolidJobsOffer, searchTerm: string): boolean {
    const term = searchTerm.toLowerCase();
    const haystacks: Array<string | null | undefined> = [
      offer.title,
      offer.category,
      offer.subCategory,
      ...(offer.skills ?? []).map((skill) => skill?.name),
    ];
    return haystacks.some((value) => (value ?? '').toLowerCase().includes(term));
  }

  /**
   * Map a solid.jobs offer to a JobPostDto.
   */
  private mapJob(
    offer: SolidJobsOffer,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    if (!offer?.jobOfferKey || !offer.title || !offer.url) return null;

    const description = this.buildDescription(offer, format);
    const compensation = this.parseCompensation(offer);
    const jobType = this.parseJobType(offer.contractTime);

    const location = new LocationDto({
      city: offer.locations?.[0] ?? null,
    });

    return new JobPostDto({
      id: `solidjobs-${offer.jobOfferKey}`,
      title: offer.title,
      companyName: offer.company ?? null,
      jobUrl: offer.url,
      location,
      description,
      compensation: compensation ?? undefined,
      jobType: jobType ?? undefined,
      isRemote: offer.isRemote === true,
      emails: extractEmails(description),
      site: Site.SOLIDJOBS,
    });
  }

  /**
   * Render the HTML description according to the requested format:
   * HTML passes the raw markup through, MARKDOWN converts via the
   * shared markdown converter, anything else converts to plain text.
   */
  private buildDescription(
    offer: SolidJobsOffer,
    format?: DescriptionFormat,
  ): string | null {
    const html = offer.description;
    if (!html) return null;
    if (format === DescriptionFormat.HTML) return html;
    if (format === DescriptionFormat.MARKDOWN) {
      return markdownConverter(html) ?? html;
    }
    return htmlToPlainText(html);
  }

  /**
   * Parse the nullable salary object into a CompensationDto.
   * Observed wire values: PLN amounts with a "Month" period.
   */
  private parseCompensation(offer: SolidJobsOffer): CompensationDto | null {
    const salary = offer.salary;
    if (!salary || (salary.from == null && salary.to == null)) return null;

    const interval = getCompensationInterval(
      (salary.period ?? '').toLowerCase(),
    );

    return new CompensationDto({
      interval: interval ?? undefined,
      minAmount: salary.from ?? null,
      maxAmount: salary.to ?? null,
      currency: salary.currency ?? 'PLN',
    });
  }

  /**
   * Resolve contractTime ("full_time" | "part_time") to a JobType.
   * Underscores are normalised to spaces because the shared alias
   * normaliser strips whitespace/hyphens but not underscores.
   */
  private parseJobType(contractTime?: string): JobType[] | null {
    if (!contractTime) return null;
    const jobType = getJobTypeFromString(contractTime.replace(/_/g, ' '));
    return jobType ? [jobType] : null;
  }
}
