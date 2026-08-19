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
} from '@ever-jobs/models';
import {
  createHttpClient,
  htmlToPlainText,
  markdownConverter,
  extractEmails,
  toDateOnly,
} from '@ever-jobs/common';
import {
  MYCAREERSFUTURE_API_URL,
  MYCAREERSFUTURE_DEFAULT_RESULTS,
  MYCAREERSFUTURE_HEADERS,
} from './mycareersfuture.constants';
import { MycareersfutureJob, MycareersfutureApiResponse } from './mycareersfuture.types';

@SourcePlugin({
  site: Site.MYCAREERSFUTURE,
  name: 'MyCareersFuture',
  category: 'regional',
})
@Injectable()
export class MycareersfutureService implements IScraper {
  private readonly logger = new Logger(MycareersfutureService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const resultsWanted = input.resultsWanted ?? MYCAREERSFUTURE_DEFAULT_RESULTS;

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(MYCAREERSFUTURE_HEADERS);

    this.logger.log(
      `Fetching MyCareersFuture jobs (resultsWanted=${resultsWanted})`,
    );

    try {
      let url = `${MYCAREERSFUTURE_API_URL}?limit=${resultsWanted}`;

      if (input.searchTerm) {
        url += `&keyword=${encodeURIComponent(input.searchTerm)}`;
      }

      const response = await client.get(url);
      const data = response.data as MycareersfutureApiResponse;

      const results = data?.results ?? [];
      if (results.length === 0) {
        this.logger.log('No jobs returned from MyCareersFuture');
        return new JobResponseDto([]);
      }

      this.logger.log(`MyCareersFuture returned ${results.length} jobs`);

      const jobs: JobPostDto[] = [];

      for (const raw of results) {
        if (jobs.length >= resultsWanted) break;

        try {
          const job = this.mapJob(raw, input.descriptionFormat);
          if (job) jobs.push(job);
        } catch (err: any) {
          this.logger.warn(
            `Error mapping MyCareersFuture job ${raw.uuid}: ${err.message}`,
          );
        }
      }

      this.logger.log(`MyCareersFuture returned ${jobs.length} jobs`);
      return new JobResponseDto(jobs);
    } catch (err: any) {
      this.logger.error(`MyCareersFuture scrape error: ${err.message}`);
      return new JobResponseDto([], classifyScrapeError(err));
    }
  }

  /**
   * Map a MyCareersFuture job to a JobPostDto.
   */
  private mapJob(
    raw: MycareersfutureJob,
    descriptionFormat?: DescriptionFormat,
  ): JobPostDto | null {
    if (!raw.uuid) return null;

    const jobUrl = `https://www.mycareersfuture.gov.sg/job/${raw.uuid}`;
    const title = raw.title;
    if (!title) return null;

    // Process description (MyCareersFuture returns HTML)
    let description: string | null = raw.description ?? null;
    if (description) {
      if (descriptionFormat === DescriptionFormat.PLAIN) {
        description = htmlToPlainText(description);
      } else if (descriptionFormat === DescriptionFormat.MARKDOWN) {
        description = markdownConverter(description) ?? description;
      }
    }

    // Build location (Singapore government board)
    const location = new LocationDto({
      city: raw.location?.name ?? null,
      country: 'Singapore',
    });

    // Build compensation from salary
    let compensation: CompensationDto | null = null;
    if (raw.salary) {
      const hasMin = raw.salary.minimum != null && raw.salary.minimum > 0;
      const hasMax = raw.salary.maximum != null && raw.salary.maximum > 0;
      if (hasMin || hasMax) {
        compensation = new CompensationDto({
          interval: CompensationInterval.MONTHLY,
          minAmount: hasMin ? raw.salary.minimum : null,
          maxAmount: hasMax ? raw.salary.maximum : null,
          currency: raw.salary.currency ?? 'SGD',
        });
      }
    }

    // Parse date
    let datePosted: string | null = null;
    if (raw.postedDate) {
      try {
        datePosted = toDateOnly(raw.postedDate);
      } catch {
        datePosted = null;
      }
    }

    return new JobPostDto({
      id: `mycareersfuture-${raw.uuid}`,
      title,
      companyName: raw.company?.name ?? null,
      jobUrl,
      location,
      description,
      compensation,
      datePosted,
      jobType: null,
      isRemote: false,
      emails: extractEmails(description ?? null),
      site: Site.MYCAREERSFUTURE,
    });
  }
}
