import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
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
  toDateOnly,
} from '@ever-jobs/common';
import { UKG_API_URL, UKG_HEADERS } from './ukg.constants';
import { UkgResponse, UkgJob } from './ukg.types';

@SourcePlugin({
  site: Site.UKG,
  name: 'UKG',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class UkgService implements IScraper {
  private readonly logger = new Logger(UkgService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug) {
      this.logger.warn('No companySlug provided for UKG scraper');
      return new JobResponseDto([]);
    }

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(UKG_HEADERS);

    const url = `${UKG_API_URL}/${encodeURIComponent(companySlug)}/OpportunitySearch`;

    try {
      this.logger.log(`Fetching UKG jobs for company: ${companySlug}`);
      const response = await client.get(url);
      const data: UkgResponse = response.data ?? { opportunities: [] };
      const jobs = data.opportunities ?? [];

      this.logger.log(`UKG: found ${jobs.length} raw jobs for ${companySlug}`);

      const resultsWanted = input.resultsWanted ?? 100;
      const jobPosts: JobPostDto[] = [];

      for (const job of jobs) {
        if (jobPosts.length >= resultsWanted) break;

        try {
          const post = this.mapJob(job, companySlug, input.descriptionFormat);
          if (post) {
            jobPosts.push(post);
          }
        } catch (err: any) {
          this.logger.warn(
            `Error processing UKG job ${job.id}: ${err.message}`,
          );
        }
      }

      return new JobResponseDto(jobPosts);
    } catch (err: any) {
      this.logger.error(
        `UKG scrape error for ${companySlug}: ${err.message}`,
      );
      return new JobResponseDto([], classifyScrapeError(err));
    }
  }

  private mapJob(
    job: UkgJob,
    companySlug: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const title = job.title;
    if (!title) return null;

    // Description
    let description: string | null = null;
    const rawDesc = job.description ?? job.shortDescription ?? null;
    if (rawDesc) {
      if (format === DescriptionFormat.HTML) {
        description = rawDesc;
      } else if (format === DescriptionFormat.MARKDOWN) {
        description = markdownConverter(rawDesc) ?? rawDesc;
      } else {
        description = htmlToPlainText(rawDesc);
      }
    }

    // Location — prefer first from array, fall back to single
    const loc = job.locations?.[0] ?? job.location ?? null;
    const location = loc
      ? new LocationDto({
          city: loc.city ?? null,
          state: loc.state ?? null,
          country: loc.country ?? null,
        })
      : null;

    // Remote detection
    const locationStr =
      loc?.formattedAddress ?? loc?.city ?? '';
    const isRemote = locationStr.toLowerCase().includes('remote');

    // Job URL
    const jobUrl =
      job.applyUrl ??
      `${UKG_API_URL}/${encodeURIComponent(companySlug)}/OpportunityDetail?opportunityId=${job.id ?? ''}`;

    return new JobPostDto({
      id: `ukg-${job.id ?? job.requisitionNumber ?? ''}`,
      title,
      companyName: job.companyName ?? companySlug,
      jobUrl,
      location,
      description,
      datePosted: job.postedDate
        ? toDateOnly(job.postedDate)
        : null,
      isRemote,
      emails: extractEmails(description),
      site: Site.UKG,
      atsId: job.id ?? job.requisitionNumber ?? null,
      atsType: 'ukg',
      department: job.department ?? job.category ?? null,
      employmentType: job.jobType ?? null,
      applyUrl: job.applyUrl ?? null,
    });
  }
}
