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
} from '@ever-jobs/common';
import {
  STARTUPJOBS_API_URL,
  STARTUPJOBS_FEED_URL,
  STARTUPJOBS_HEADERS,
} from './startupjobs.constants';
import { StartupJob } from './startupjobs.types';

@SourcePlugin({
  site: Site.STARTUPJOBS,
  name: 'StartupJobs',
  category: 'niche',
})
@Injectable()
export class StartupJobsService implements IScraper {
  private readonly logger = new Logger(StartupJobsService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const limit = input.resultsWanted ?? 25;

    this.logger.log(
      `StartupJobs scrape: search="${input.searchTerm ?? ''}" limit=${limit}`,
    );

    try {
      const http = createHttpClient({
        proxies: input.proxies,
        caCert: input.caCert,
        timeout: input.requestTimeout,
      });

      let rawJobs = await this.fetchJobs(http);

      if (!rawJobs || rawJobs.length === 0) {
        this.logger.warn('StartupJobs returned empty or invalid response');
        return new JobResponseDto([]);
      }

      this.logger.log(`StartupJobs returned ${rawJobs.length} raw jobs`);

      // Filter by search term if provided
      if (input.searchTerm) {
        const term = input.searchTerm.toLowerCase();
        rawJobs = rawJobs.filter((job) => {
          const title = (job.title ?? '').toLowerCase();
          return title.includes(term);
        });
      }

      // Limit results
      rawJobs = rawJobs.slice(0, limit);

      const jobs: JobPostDto[] = [];

      for (const entry of rawJobs) {
        try {
          const job = this.mapJob(entry, input.descriptionFormat);
          if (job) {
            jobs.push(job);
          }
        } catch (err: any) {
          this.logger.warn(
            `Error mapping StartupJobs job ${entry.id}: ${err.message}`,
          );
        }
      }

      this.logger.log(`StartupJobs mapped ${jobs.length} jobs`);
      return new JobResponseDto(jobs);
    } catch (err: any) {
      this.logger.error(`StartupJobs scrape error: ${err.message}`);
      return new JobResponseDto([], classifyScrapeError(err));
    }
  }

  /**
   * Attempt to fetch jobs from the primary API endpoint.
   * If that fails, fall back to the feed.json endpoint.
   */
  private async fetchJobs(http: any): Promise<StartupJob[]> {
    // Try the primary API endpoint first
    try {
      const response = await http.get(
        STARTUPJOBS_API_URL,
        { headers: STARTUPJOBS_HEADERS },
      );

      const data = response.data;

      if (Array.isArray(data)) {
        return data;
      }
      if (data && Array.isArray((data as any).jobs)) {
        return (data as any).jobs;
      }

      this.logger.warn('Primary API returned unexpected format, trying feed.json');
    } catch (err: any) {
      this.logger.warn(
        `Primary API failed (${err.message}), trying feed.json fallback`,
      );
    }

    // Fallback to feed.json
    try {
      const response = await http.get(
        STARTUPJOBS_FEED_URL,
        { headers: STARTUPJOBS_HEADERS },
      );

      const data = response.data;

      if (Array.isArray(data)) {
        return data;
      }
      if (data && Array.isArray((data as any).items)) {
        return (data as any).items;
      }
      if (data && Array.isArray((data as any).jobs)) {
        return (data as any).jobs;
      }

      this.logger.warn('Feed.json returned unexpected format');
      return [];
    } catch (err: any) {
      this.logger.error(`Feed.json fallback also failed: ${err.message}`);
      return [];
    }
  }

  /**
   * Map a raw StartupJobs API job object to a JobPostDto.
   */
  private mapJob(
    entry: StartupJob,
    descriptionFormat?: DescriptionFormat,
  ): JobPostDto | null {
    if (!entry.title) {
      return null;
    }

    // Resolve company name from company_name or company.name
    const companyName = entry.company_name || entry.company?.name || null;

    // Resolve company logo
    const companyLogo = entry.company?.logo || null;

    // Resolve job URL or construct from id
    const jobUrl =
      entry.url || `https://startup.jobs/jobs/${entry.id}`;

    // Process description
    let description: string | null = entry.description ?? null;
    if (description) {
      if (descriptionFormat === DescriptionFormat.PLAIN) {
        description = htmlToPlainText(description);
      } else if (descriptionFormat === DescriptionFormat.MARKDOWN) {
        description = markdownConverter(description) ?? description;
      }
    }

    // Build location
    const location = new LocationDto({
      city: entry.location || null,
    });

    // Parse date from published_at or created_at
    const rawDate = entry.published_at || entry.created_at || null;
    const datePosted = rawDate ? rawDate.split('T')[0] : null;

    return new JobPostDto({
      id: `startupjobs-${entry.id}`,
      title: entry.title,
      companyName,
      companyLogo,
      jobUrl,
      location,
      description,
      compensation: null,
      datePosted,
      isRemote: entry.remote ?? null,
      emails: extractEmails(description),
      site: Site.STARTUPJOBS,
      skills: entry.tags && entry.tags.length > 0 ? entry.tags : null,
    });
  }
}
