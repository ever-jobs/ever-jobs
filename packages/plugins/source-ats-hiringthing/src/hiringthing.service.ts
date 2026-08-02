import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
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
import { HIRINGTHING_API_URL, HIRINGTHING_HEADERS } from './hiringthing.constants';
import { HiringThingResponse, HiringThingJob } from './hiringthing.types';

@SourcePlugin({
  site: Site.HIRINGTHING,
  name: 'HiringThing',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class HiringThingService implements IScraper {
  private readonly logger = new Logger(HiringThingService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    // Check for API key: per-request auth overrides env var
    const authAny = input.auth as Record<string, any> | undefined;
    const apiKey =
      authAny?.hiringThing?.apiKey ?? process.env.HIRINGTHING_API_KEY;

    if (!apiKey) {
      this.logger.warn(
        'HiringThing: no API key available. ' +
          'Provide HIRINGTHING_API_KEY env var or input.auth.hiringThing.apiKey.',
      );
      return new JobResponseDto([]);
    }

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(HIRINGTHING_HEADERS);

    // HiringThing uses Basic Auth with the API key as username and empty password
    const authToken = Buffer.from(`${apiKey}:`).toString('base64');

    try {
      this.logger.log('Fetching HiringThing jobs via authenticated API');
      const response = await client.get<HiringThingResponse>(
        HIRINGTHING_API_URL,
        {
          headers: {
            Authorization: `Basic ${authToken}`,
          },
        },
      );

      const data = response.data ?? { jobs: [] };
      const jobs = data.jobs ?? [];

      this.logger.log(`HiringThing: found ${jobs.length} jobs`);

      const resultsWanted = input.resultsWanted ?? 100;
      const jobPosts: JobPostDto[] = [];

      for (const job of jobs) {
        if (jobPosts.length >= resultsWanted) break;

        try {
          const post = this.mapJob(job, input.descriptionFormat);
          if (post) {
            jobPosts.push(post);
          }
        } catch (err: any) {
          this.logger.warn(
            `Error processing HiringThing job ${job.id}: ${err.message}`,
          );
        }
      }

      return new JobResponseDto(jobPosts);
    } catch (err: any) {
      this.logger.error(`HiringThing scrape error: ${err.message}`);
      return new JobResponseDto([]);
    }
  }

  /**
   * Map a HiringThing API job object to a JobPostDto.
   */
  private mapJob(
    job: HiringThingJob,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const title = job.title;
    if (!title) return null;

    // Description — API returns HTML
    let description: string | null = null;
    if (job.description) {
      if (format === DescriptionFormat.HTML) {
        description = job.description;
      } else if (format === DescriptionFormat.MARKDOWN) {
        description =
          markdownConverter(job.description) ?? job.description;
      } else {
        description = htmlToPlainText(job.description);
      }
    }

    // Location — API provides a single location string
    const location = job.location
      ? new LocationDto({ city: job.location })
      : null;

    // Compensation — parse salary string if available
    let compensation: CompensationDto | null = null;
    if (job.salary) {
      compensation = new CompensationDto({
        currency: 'USD',
        interval: CompensationInterval.YEARLY,
      });
    }

    // Job URL — required field; fall back to a constructed URL if missing
    const jobUrl = job.url ?? `https://api.hiringthing.com/jobs/${job.id}`;

    // Date posted
    const datePosted = job.created_at
      ? toDateOnly(job.created_at)
      : null;

    return new JobPostDto({
      id: `hiringthing-${job.id}`,
      title,
      companyName: job.company_name ?? null,
      jobUrl,
      location,
      description,
      compensation,
      datePosted,
      emails: extractEmails(description),
      site: Site.HIRINGTHING,
      atsId: String(job.id),
      atsType: 'hiringthing',
      department: job.department ?? null,
      employmentType: job.type ?? null,
    });
  }
}
