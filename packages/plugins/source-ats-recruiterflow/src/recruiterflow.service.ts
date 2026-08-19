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
import { RECRUITERFLOW_BASE_URL, RECRUITERFLOW_HEADERS } from './recruiterflow.constants';
import { RecruiterflowJob, RecruiterflowApiResponse } from './recruiterflow.types';

@SourcePlugin({
  site: Site.RECRUITERFLOW,
  name: 'Recruiterflow',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class RecruiterflowService implements IScraper {
  private readonly logger = new Logger(RecruiterflowService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug) {
      this.logger.warn('No companySlug provided for Recruiterflow scraper');
      return new JobResponseDto([]);
    }

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders({
      ...RECRUITERFLOW_HEADERS,
      'RF-Api-Key': companySlug,
    });

    const resultsWanted = input.resultsWanted ?? 100;
    const url = RECRUITERFLOW_BASE_URL;

    try {
      this.logger.log(`Fetching Recruiterflow jobs for company: ${companySlug}`);
      const response = await client.get(url);
      const apiResponse: RecruiterflowApiResponse = response.data ?? { data: [], total_items: 0 };

      let jobs: RecruiterflowJob[] = apiResponse.data ?? [];

      if (!Array.isArray(jobs)) {
        this.logger.warn(`Unexpected Recruiterflow response format for ${companySlug}`);
        return new JobResponseDto([]);
      }

      this.logger.log(`Recruiterflow: found ${jobs.length} raw jobs for ${companySlug}`);

      // Filter by searchTerm (case-insensitive match on title and description)
      if (input.searchTerm) {
        const term = input.searchTerm.toLowerCase();
        jobs = jobs.filter((job) => {
          const title = job.title?.toLowerCase() ?? '';
          const desc = job.description?.toLowerCase() ?? '';
          return title.includes(term) || desc.includes(term);
        });
      }

      const jobPosts: JobPostDto[] = [];

      for (const job of jobs) {
        if (jobPosts.length >= resultsWanted) break;

        try {
          const post = this.processJob(job, companySlug, input.descriptionFormat);
          if (post) {
            jobPosts.push(post);
          }
        } catch (err: any) {
          this.logger.warn(`Error processing Recruiterflow job ${job.id}: ${err.message}`);
        }
      }

      return new JobResponseDto(jobPosts);
    } catch (err: any) {
      this.logger.error(`Recruiterflow scrape error for ${companySlug}: ${err.message}`);
      return new JobResponseDto([], classifyScrapeError(err));
    }
  }

  private processJob(
    job: RecruiterflowJob,
    companySlug: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const title = job.title;
    if (!title) return null;

    // Description processing
    let description: string | null = null;
    if (job.description) {
      if (format === DescriptionFormat.HTML) {
        description = job.description;
      } else if (format === DescriptionFormat.MARKDOWN) {
        description = markdownConverter(job.description) ?? job.description;
      } else {
        description = htmlToPlainText(job.description);
      }
    }

    // Location from string field
    const locationDto = job.location
      ? new LocationDto({
          city: job.location,
          state: null,
          country: null,
        })
      : null;

    // Remote detection: check if location contains "remote" (case insensitive)
    const isRemote = job.location?.toLowerCase().includes('remote') ?? false;

    // Job URL
    const jobUrl = `https://recruiterflow.com/jobs/${encodeURIComponent(companySlug)}/${encodeURIComponent(String(job.id))}`;

    // Date posted
    const datePosted = job.created_at
      ? toDateOnly(job.created_at)
      : null;

    return new JobPostDto({
      id: `recruiterflow-${job.id}`,
      title,
      companyName: companySlug,
      jobUrl,
      location: locationDto,
      description,
      datePosted,
      isRemote,
      emails: extractEmails(description),
      site: Site.RECRUITERFLOW,
      // ATS-specific fields
      atsId: job.id?.toString() ?? null,
      atsType: 'recruiterflow',
      department: null,
    });
  }
}
