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
import { HOMERUN_API_URL, HOMERUN_HEADERS } from './homerun.constants';
import { HomerunJob, HomerunResponse } from './homerun.types';

@SourcePlugin({
  site: Site.HOMERUN,
  name: 'Homerun',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class HomerunService implements IScraper {
  private readonly logger = new Logger(HomerunService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug) {
      this.logger.warn('No companySlug provided for Homerun scraper');
      return new JobResponseDto([]);
    }

    const apiKey = process.env.HOMERUN_API_KEY;
    if (!apiKey) {
      this.logger.warn('No HOMERUN_API_KEY found in environment');
      return new JobResponseDto([]);
    }

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders({
      ...HOMERUN_HEADERS,
      Authorization: `Bearer ${apiKey}`,
    });

    const perPage = input.resultsWanted ?? 20;
    const url = `${HOMERUN_API_URL}?page=1&perPage=${perPage}`;

    try {
      this.logger.log(`Fetching Homerun jobs for company: ${companySlug}`);
      const response = await client.get(url);
      const data: HomerunResponse = response.data ?? {};
      let jobs: HomerunJob[] = data.data ?? [];

      if (!Array.isArray(jobs)) {
        this.logger.warn(`Unexpected Homerun response format for ${companySlug}`);
        return new JobResponseDto([]);
      }

      this.logger.log(`Homerun: found ${jobs.length} raw jobs for ${companySlug}`);

      // Filter by searchTerm (case-insensitive title match) if provided
      if (input.searchTerm) {
        const term = input.searchTerm.toLowerCase();
        jobs = jobs.filter((job) => job.title?.toLowerCase().includes(term));
      }

      const resultsWanted = input.resultsWanted ?? 100;
      const jobPosts: JobPostDto[] = [];

      for (const job of jobs) {
        if (jobPosts.length >= resultsWanted) break;

        try {
          const post = this.processJob(job, companySlug, input.descriptionFormat);
          if (post) {
            jobPosts.push(post);
          }
        } catch (err: any) {
          this.logger.warn(`Error processing Homerun job ${job.id}: ${err.message}`);
        }
      }

      return new JobResponseDto(jobPosts);
    } catch (err: any) {
      this.logger.error(`Homerun scrape error for ${companySlug}: ${err.message}`);
      return new JobResponseDto([], classifyScrapeError(err));
    }
  }

  private processJob(
    job: HomerunJob,
    companySlug: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const title = job.title;
    if (!title) return null;

    // Description is HTML content
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

    // Location from location string
    const locationStr = job.location ?? null;
    const location = locationStr
      ? new LocationDto({ city: locationStr })
      : null;

    // Remote detection from location string
    const isRemote = locationStr?.toLowerCase().includes('remote') ?? false;

    // Job URL: prefer application_url, fall back to constructed URL
    const jobUrl =
      job.application_url ?? `https://app.homerun.co/${companySlug}/${job.slug ?? job.id}`;

    // Date posted
    const datePosted = job.created_at
      ? toDateOnly(job.created_at)
      : null;

    return new JobPostDto({
      id: `homerun-${job.id}`,
      title,
      companyName: companySlug,
      jobUrl,
      location,
      description,
      datePosted,
      isRemote,
      emails: extractEmails(description),
      site: Site.HOMERUN,
      // ATS-specific fields
      atsId: job.id?.toString() ?? null,
      atsType: 'homerun',
      department: job.department ?? null,
      employmentType: job.employment_type ?? null,
    });
  }
}
