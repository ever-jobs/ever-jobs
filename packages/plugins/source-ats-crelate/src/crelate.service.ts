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
  toDateOnly,
} from '@ever-jobs/common';
import { CRELATE_BASE_URL, CRELATE_HEADERS } from './crelate.constants';
import { CrelateJob } from './crelate.types';

@SourcePlugin({
  site: Site.CRELATE,
  name: 'Crelate',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class CrelateService implements IScraper {
  private readonly logger = new Logger(CrelateService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug) {
      this.logger.warn('No companySlug provided for Crelate scraper');
      return new JobResponseDto([]);
    }

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders({
      ...CRELATE_HEADERS,
      'X-Api-Key': companySlug,
    });

    const resultsWanted = input.resultsWanted ?? 100;
    const url = `${CRELATE_BASE_URL}?published=true&offset=0&limit=${resultsWanted}`;

    try {
      this.logger.log(`Fetching Crelate jobs for company: ${companySlug}`);
      const response = await client.get(url);
      let jobs: CrelateJob[] = response.data ?? [];

      if (!Array.isArray(jobs)) {
        this.logger.warn(`Unexpected Crelate response format for ${companySlug}`);
        return new JobResponseDto([]);
      }

      this.logger.log(`Crelate: found ${jobs.length} raw jobs for ${companySlug}`);

      // Filter by searchTerm (case-insensitive match on title and description)
      if (input.searchTerm) {
        const term = input.searchTerm.toLowerCase();
        jobs = jobs.filter((job) => {
          const title = job.name?.toLowerCase() ?? '';
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
          this.logger.warn(`Error processing Crelate job ${job.id}: ${err.message}`);
        }
      }

      return new JobResponseDto(jobPosts);
    } catch (err: any) {
      this.logger.error(`Crelate scrape error for ${companySlug}: ${err.message}`);
      return new JobResponseDto([]);
    }
  }

  private processJob(
    job: CrelateJob,
    companySlug: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const title = job.name;
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

    // Location from flat fields
    const location =
      job.city || job.state_province || job.country
        ? new LocationDto({
            city: job.city ?? null,
            state: job.state_province ?? null,
            country: job.country ?? null,
          })
        : null;

    // Remote detection from is_remote field
    const isRemote = job.is_remote ?? false;

    // Job URL
    const jobUrl = `https://app.crelate.com/portal/${encodeURIComponent(companySlug)}/job/${encodeURIComponent(job.id)}`;

    // Date posted
    const datePosted = job.created_date
      ? toDateOnly(job.created_date)
      : null;

    return new JobPostDto({
      id: `crelate-${job.id}`,
      title,
      companyName: companySlug,
      jobUrl,
      location,
      description,
      datePosted,
      isRemote,
      emails: extractEmails(description),
      site: Site.CRELATE,
      // ATS-specific fields
      atsId: job.id?.toString() ?? null,
      atsType: 'crelate',
      department: null,
    });
  }
}
