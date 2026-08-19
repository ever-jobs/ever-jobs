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
import { ISMARTRECRUIT_BASE_URL, ISMARTRECRUIT_HEADERS } from './ismartrecruit.constants';
import { ISmartRecruitJob } from './ismartrecruit.types';

@SourcePlugin({
  site: Site.ISMARTRECRUIT,
  name: 'iSmartRecruit',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class ISmartRecruitService implements IScraper {
  private readonly logger = new Logger(ISmartRecruitService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug) {
      this.logger.warn('No companySlug provided for iSmartRecruit scraper');
      return new JobResponseDto([]);
    }

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(ISMARTRECRUIT_HEADERS);

    const resultsWanted = input.resultsWanted ?? 100;
    const searchTerm = input.searchTerm ?? '';
    const location = input.location ?? '';

    const params = new URLSearchParams({
      apiKey: companySlug,
      jobTitle: searchTerm,
      city: location,
      start: '0',
      numOfRecords: String(resultsWanted),
    });
    const url = `${ISMARTRECRUIT_BASE_URL}?${params.toString()}`;

    try {
      this.logger.log(`Fetching iSmartRecruit jobs for company: ${companySlug}`);
      const response = await client.get(url);
      let jobs: ISmartRecruitJob[] = response.data ?? [];

      if (!Array.isArray(jobs)) {
        this.logger.warn(`Unexpected iSmartRecruit response format for ${companySlug}`);
        return new JobResponseDto([]);
      }

      this.logger.log(`iSmartRecruit: found ${jobs.length} raw jobs for ${companySlug}`);

      // Filter by searchTerm (case-insensitive match on title and description)
      if (input.searchTerm) {
        const term = input.searchTerm.toLowerCase();
        jobs = jobs.filter((job) => {
          const title = job.jobTitle?.toLowerCase() ?? '';
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
          this.logger.warn(`Error processing iSmartRecruit job ${job.jobId}: ${err.message}`);
        }
      }

      return new JobResponseDto(jobPosts);
    } catch (err: any) {
      this.logger.error(`iSmartRecruit scrape error for ${companySlug}: ${err.message}`);
      return new JobResponseDto([], classifyScrapeError(err));
    }
  }

  private processJob(
    job: ISmartRecruitJob,
    companySlug: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const title = job.jobTitle;
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
    const locationDto =
      job.city || job.country
        ? new LocationDto({
            city: job.city ?? null,
            state: null,
            country: job.country ?? null,
          })
        : null;

    // Remote detection: check if city contains "remote" (case insensitive)
    const isRemote = job.city?.toLowerCase().includes('remote') ?? false;

    // Job URL from applyUrl or constructed
    const jobUrl =
      job.applyUrl ?? `https://app.ismartrecruit.com/jobDescription/${encodeURIComponent(job.jobId)}`;

    // Date posted
    const datePosted = job.datePosted
      ? toDateOnly(job.datePosted)
      : null;

    return new JobPostDto({
      id: `ismartrecruit-${job.jobId}`,
      title,
      companyName: job.companyName ?? companySlug,
      jobUrl,
      location: locationDto,
      description,
      datePosted,
      isRemote,
      emails: extractEmails(description),
      site: Site.ISMARTRECRUIT,
      // ATS-specific fields
      atsId: job.jobId?.toString() ?? null,
      atsType: 'ismartrecruit',
      department: job.jobCategory ?? null,
      applyUrl: job.applyUrl ?? null,
    });
  }
}
