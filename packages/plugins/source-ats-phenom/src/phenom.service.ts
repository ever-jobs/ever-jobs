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
  PHENOM_BASE_URL_TEMPLATE,
  PHENOM_HEADERS,
  PHENOM_PAGE_SIZE,
  PHENOM_REQUEST_DELAY_MS,
} from './phenom.constants';
import { PhenomJob, PhenomResponse } from './phenom.types';

@SourcePlugin({
  site: Site.PHENOM,
  name: 'Phenom',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class PhenomService implements IScraper {
  private readonly logger = new Logger(PhenomService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug) {
      this.logger.warn('No companySlug provided for Phenom scraper');
      return new JobResponseDto([]);
    }

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(PHENOM_HEADERS);

    const resultsWanted = input.resultsWanted ?? 100;
    const jobPosts: JobPostDto[] = [];
    let offset = 0;

    const baseUrl = this.buildBaseUrl(companySlug);

    try {
      this.logger.log(`Fetching Phenom jobs for company: ${companySlug}`);

      while (jobPosts.length < resultsWanted) {
        const url = `${baseUrl}?offset=${offset}&limit=${PHENOM_PAGE_SIZE}`;

        const response = await client.get(url);
        const data: PhenomResponse = response.data ?? { jobs: [] };
        const jobs = data.jobs ?? [];

        if (jobs.length === 0) break;

        this.logger.log(
          `Phenom: fetched ${jobs.length} jobs at offset ${offset} for ${companySlug}`,
        );

        for (const job of jobs) {
          if (jobPosts.length >= resultsWanted) break;

          try {
            const post = this.processJob(
              job,
              companySlug,
              input.descriptionFormat,
            );
            if (post) {
              jobPosts.push(post);
            }
          } catch (err: any) {
            this.logger.warn(
              `Error processing Phenom job ${job.id}: ${err.message}`,
            );
          }
        }

        offset += jobs.length;

        // If we got fewer results than page size, no more pages
        if (jobs.length < PHENOM_PAGE_SIZE) break;

        // Delay between pagination requests
        await randomSleep(
          PHENOM_REQUEST_DELAY_MS,
          PHENOM_REQUEST_DELAY_MS * 3,
        );
      }

      this.logger.log(
        `Phenom total: ${jobPosts.length} jobs for ${companySlug}`,
      );
      return new JobResponseDto(jobPosts);
    } catch (err: any) {
      this.logger.error(
        `Phenom scrape error for ${companySlug}: ${err.message}`,
      );
      return new JobResponseDto(jobPosts); // Return what we have so far
    }
  }

  /**
   * Build the base API URL for a given company slug.
   * Uses the standard Phenom career site URL pattern.
   */
  private buildBaseUrl(companySlug: string): string {
    return PHENOM_BASE_URL_TEMPLATE.replace(
      '{companySlug}',
      encodeURIComponent(companySlug),
    );
  }

  /**
   * Map a raw Phenom job object to a standardized JobPostDto.
   */
  private processJob(
    job: PhenomJob,
    companySlug: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const title = job.title;
    if (!title) return null;

    // Description: convert based on requested format
    let description: string | null = null;
    const rawDescription = job.description ?? job.shortDescription ?? null;
    if (rawDescription) {
      if (format === DescriptionFormat.HTML) {
        description = rawDescription;
      } else if (format === DescriptionFormat.MARKDOWN) {
        description = markdownConverter(rawDescription) ?? rawDescription;
      } else {
        description = htmlToPlainText(rawDescription);
      }
    }

    // Location
    const location = this.extractLocation(job);

    // Remote detection
    const isRemote = this.detectRemote(job);

    // Date posted: handle both ISO strings and epoch timestamps
    const datePosted = this.parseDate(
      job.postedDate ?? job.posted_date ?? job.createdDate,
    );

    // Job URL
    const jobUrl =
      job.url ??
      job.applyUrl ??
      `https://jobs.${companySlug}.com/job/${job.id}`;

    // Employment type
    const employmentType = job.type ?? job.employmentType ?? null;

    return new JobPostDto({
      id: `phenom-${job.id ?? job.reqId}`,
      title,
      companyName: job.companyName ?? companySlug,
      jobUrl,
      location,
      description,
      datePosted,
      isRemote,
      emails: extractEmails(description),
      site: Site.PHENOM,
      // ATS-specific fields
      atsId: String(job.id ?? job.reqId ?? ''),
      atsType: 'phenom',
      department: job.department ?? job.category ?? null,
      employmentType,
      applyUrl: job.applyUrl ?? job.url ?? null,
    });
  }

  /**
   * Extract a structured LocationDto from the Phenom job.
   * Handles both structured location objects and plain text location strings.
   */
  private extractLocation(job: PhenomJob): LocationDto | null {
    if (job.location) {
      return new LocationDto({
        city: job.location.city ?? null,
        state: job.location.state ?? null,
        country: job.location.country ?? null,
      });
    }

    // Fall back to parsing locationText
    if (job.locationText) {
      const parts = job.locationText.split(',').map((p) => p.trim());
      return new LocationDto({
        city: parts[0] ?? null,
        state: parts[1] ?? null,
        country: parts[2] ?? null,
      });
    }

    return null;
  }

  /**
   * Detect whether a job is remote from various fields.
   */
  private detectRemote(job: PhenomJob): boolean {
    if (job.isRemote === true) return true;

    const remoteKeywords = ['remote', 'work from home', 'wfh', 'telecommute'];
    const fieldsToCheck = [
      job.workplaceType,
      job.locationText,
      job.type,
      job.title,
    ];

    for (const field of fieldsToCheck) {
      if (
        field &&
        remoteKeywords.some((kw) => field.toLowerCase().includes(kw))
      ) {
        return true;
      }
    }

    return false;
  }

  /**
   * Parse a date value that may be an ISO string, epoch ms, or epoch seconds.
   * Returns an ISO date string (YYYY-MM-DD) or null.
   */
  private parseDate(value: string | number | null | undefined): string | null {
    if (value == null) return null;

    try {
      if (typeof value === 'number') {
        // Epoch in milliseconds (13 digits) vs seconds (10 digits)
        const ms = value > 1e12 ? value : value * 1000;
        return toDateOnly(ms);
      }

      if (typeof value === 'string') {
        const parsed = new Date(value);
        if (!isNaN(parsed.getTime())) {
          return toDateOnly(value);
        }
      }
    } catch {
      // Ignore parse errors
    }

    return null;
  }
}
