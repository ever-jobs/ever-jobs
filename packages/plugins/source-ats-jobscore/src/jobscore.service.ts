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
import { JOBSCORE_BASE_URL, JOBSCORE_HEADERS } from './jobscore.constants';
import { JobScoreJob } from './jobscore.types';

@SourcePlugin({
  site: Site.JOBSCORE,
  name: 'JobScore',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class JobScoreService implements IScraper {
  private readonly logger = new Logger(JobScoreService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug) {
      this.logger.warn('No companySlug provided for JobScore scraper');
      return new JobResponseDto([]);
    }

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(JOBSCORE_HEADERS);

    const resultsWanted = input.resultsWanted ?? 100;
    const url = `${JOBSCORE_BASE_URL}/${encodeURIComponent(companySlug)}/feed.json?sort=date&limit=${resultsWanted}`;

    try {
      this.logger.log(`Fetching JobScore jobs for company: ${companySlug}`);
      const response = await client.get(url);
      let jobs: JobScoreJob[] = response.data ?? [];

      if (!Array.isArray(jobs)) {
        this.logger.warn(`Unexpected JobScore response format for ${companySlug}`);
        return new JobResponseDto([]);
      }

      this.logger.log(`JobScore: found ${jobs.length} raw jobs for ${companySlug}`);

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
          this.logger.warn(`Error processing JobScore job ${job.id}: ${err.message}`);
        }
      }

      return new JobResponseDto(jobPosts);
    } catch (err: any) {
      this.logger.error(`JobScore scrape error for ${companySlug}: ${err.message}`);
      return new JobResponseDto([]);
    }
  }

  private processJob(
    job: JobScoreJob,
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

    // Location from nested location object
    const loc = job.location;
    const location =
      loc && (loc.city || loc.state || loc.country)
        ? new LocationDto({
            city: loc.city ?? null,
            state: loc.state ?? null,
            country: loc.country ?? null,
          })
        : null;

    // Remote detection from location fields
    const isRemote =
      loc?.city?.toLowerCase().includes('remote') ??
      loc?.state?.toLowerCase().includes('remote') ??
      false;

    // Job URL from detail_url field
    const jobUrl =
      job.detail_url ??
      `https://careers.jobscore.com/jobs/${encodeURIComponent(companySlug)}/${job.id}`;

    // Date posted
    const datePosted = job.created_at
      ? toDateOnly(job.created_at)
      : null;

    return new JobPostDto({
      id: `jobscore-${job.id}`,
      title,
      companyName: companySlug,
      jobUrl,
      location,
      description,
      datePosted,
      isRemote,
      emails: extractEmails(description),
      site: Site.JOBSCORE,
      // ATS-specific fields
      atsId: job.id?.toString() ?? null,
      atsType: 'jobscore',
      department: job.department ?? null,
    });
  }
}
