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
import { JOBYLON_API_URL, JOBYLON_HEADERS } from './jobylon.constants';
import { JobylonJob } from './jobylon.types';

@SourcePlugin({
  site: Site.JOBYLON,
  name: 'Jobylon',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class JobylonService implements IScraper {
  private readonly logger = new Logger(JobylonService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug) {
      this.logger.warn('No companySlug provided for Jobylon scraper');
      return new JobResponseDto([]);
    }

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(JOBYLON_HEADERS);

    const url = `${JOBYLON_API_URL}/${encodeURIComponent(companySlug)}/?format=json`;

    try {
      this.logger.log(`Fetching Jobylon jobs for company: ${companySlug}`);
      const response = await client.get(url);
      let jobs: JobylonJob[] = response.data ?? [];

      if (!Array.isArray(jobs)) {
        this.logger.warn(`Unexpected Jobylon response format for ${companySlug}`);
        return new JobResponseDto([]);
      }

      this.logger.log(`Jobylon: found ${jobs.length} raw jobs for ${companySlug}`);

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
          this.logger.warn(`Error processing Jobylon job ${job.id}: ${err.message}`);
        }
      }

      return new JobResponseDto(jobPosts);
    } catch (err: any) {
      this.logger.error(`Jobylon scrape error for ${companySlug}: ${err.message}`);
      return new JobResponseDto([]);
    }
  }

  private processJob(
    job: JobylonJob,
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

    // Location from first location object
    const loc = job.locations?.[0] ?? null;
    const location = loc
      ? new LocationDto({
          city: loc.city ?? null,
          country: loc.country ?? null,
        })
      : null;

    // Remote detection from workspace_type
    const isRemote =
      job.workspace_type?.toLowerCase() === 'remote' ||
      loc?.city?.toLowerCase().includes('remote') ||
      false;

    // Job URL: prefer urls.ad, fall back to constructed URL
    const jobUrl =
      job.urls?.ad ?? `https://jobs.jobylon.com/jobs/${job.slug ?? job.id}/`;

    // Date posted
    const datePosted = job.from_date
      ? toDateOnly(job.from_date)
      : null;

    // Skills from skills array
    const skills = job.skills
      ?.map((s) => s.label)
      .filter((label): label is string => !!label) ?? [];

    return new JobPostDto({
      id: `jobylon-${job.id}`,
      title,
      companyName: job.company?.name ?? companySlug,
      jobUrl,
      location,
      description,
      datePosted,
      isRemote,
      emails: extractEmails(description),
      site: Site.JOBYLON,
      // ATS-specific fields
      atsId: job.id?.toString() ?? null,
      atsType: 'jobylon',
      department: job.department ?? null,
      employmentType: job.employment_type ?? null,
      skills: skills.length > 0 ? skills : undefined,
    });
  }
}
