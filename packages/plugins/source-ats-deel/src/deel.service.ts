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
  CompensationInterval,
  Site,
  DescriptionFormat,
  getCompensationInterval,
} from '@ever-jobs/models';
import {
  createHttpClient,
  htmlToPlainText,
  markdownConverter,
  extractEmails,
  toDateOnly,
} from '@ever-jobs/common';
import { DEEL_API_URL, DEEL_HEADERS } from './deel.constants';
import { DeelJobPosting, DeelResponse } from './deel.types';

@SourcePlugin({
  site: Site.DEEL,
  name: 'Deel',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class DeelService implements IScraper {
  private readonly logger = new Logger(DeelService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    // Resolve API token: per-request auth overrides env var
    const apiToken =
      input.auth?.deel?.apiToken ?? process.env.DEEL_API_TOKEN;

    if (!apiToken) {
      this.logger.warn(
        'No Deel API token provided (set DEEL_API_TOKEN env var or pass auth.deel.apiToken)',
      );
      return new JobResponseDto([]);
    }

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });

    client.setHeaders({
      ...DEEL_HEADERS,
      Authorization: `Bearer ${apiToken}`,
    });

    try {
      this.logger.log('Fetching Deel ATS job postings');
      const response = await client.get(DEEL_API_URL);
      const data: DeelResponse = response.data ?? { data: [] };
      const postings = data.data ?? [];

      this.logger.log(`Deel: found ${postings.length} raw job postings`);

      const resultsWanted = input.resultsWanted ?? 100;
      const jobPosts: JobPostDto[] = [];

      for (const posting of postings) {
        if (jobPosts.length >= resultsWanted) break;

        try {
          const post = this.processJob(posting, input.descriptionFormat);
          if (post) {
            jobPosts.push(post);
          }
        } catch (err: any) {
          this.logger.warn(
            `Error processing Deel job ${posting.id}: ${err.message}`,
          );
        }
      }

      return new JobResponseDto(jobPosts);
    } catch (err: any) {
      this.logger.error(`Deel scrape error: ${err.message}`);
      return new JobResponseDto([], classifyScrapeError(err));
    }
  }

  private processJob(
    posting: DeelJobPosting,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const title = posting.title;
    if (!title) return null;

    // Description — Deel returns HTML by default
    let description: string | null = null;
    if (posting.description) {
      if (format === DescriptionFormat.HTML) {
        description = posting.description;
      } else if (format === DescriptionFormat.MARKDOWN) {
        description =
          markdownConverter(posting.description) ?? posting.description;
      } else {
        description = htmlToPlainText(posting.description);
      }
    }

    // Location
    const location = new LocationDto({
      city: posting.location?.city ?? null,
      state: posting.location?.state ?? null,
      country: posting.location?.country ?? null,
    });

    // Compensation
    const compensation = this.extractCompensation(posting);

    // Job URL
    const jobUrl = posting.url ?? posting.apply_url ?? null;

    // Date posted
    const datePosted = posting.created_at
      ? toDateOnly(posting.created_at)
      : null;

    return new JobPostDto({
      id: `deel-${posting.id}`,
      title,
      companyName: posting.company_name ?? undefined,
      jobUrl: jobUrl ?? '',
      location,
      description,
      compensation,
      datePosted,
      isRemote: posting.remote ?? false,
      emails: extractEmails(description),
      site: Site.DEEL,
      // ATS-specific fields
      atsId: posting.id ?? null,
      atsType: 'deel',
      department: posting.department ?? null,
      team: posting.team ?? null,
      employmentType: posting.employment_type ?? null,
      applyUrl: posting.apply_url ?? null,
    });
  }

  /**
   * Extract compensation from Deel salary fields.
   * Skips if both min_amount and max_amount are null.
   */
  private extractCompensation(posting: DeelJobPosting): CompensationDto | null {
    const salary = posting.salary;
    if (!salary) return null;
    if (salary.min_amount == null && salary.max_amount == null) return null;

    const rawInterval = salary.interval?.toLowerCase() ?? '';
    const interval = getCompensationInterval(rawInterval);

    return new CompensationDto({
      interval: interval ?? CompensationInterval.YEARLY,
      minAmount: salary.min_amount ?? undefined,
      maxAmount: salary.max_amount ?? undefined,
      currency: salary.currency ?? 'USD',
    });
  }
}
