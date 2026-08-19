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
  Site,
  DescriptionFormat,
  CompensationInterval,
} from '@ever-jobs/models';
import {
  createHttpClient,
  htmlToPlainText,
  markdownConverter,
  extractEmails,
} from '@ever-jobs/common';
import { FOURDAYWEEK_API_URL, FOURDAYWEEK_HEADERS } from './fourdayweek.constants';
import { FourDayWeekJob } from './fourdayweek.types';

@SourcePlugin({
  site: Site.FOURDAYWEEK,
  name: '4DayWeek',
  category: 'remote',
})
@Injectable()
export class FourDayWeekService implements IScraper {
  private readonly logger = new Logger(FourDayWeekService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const limit = input.resultsWanted ?? 25;

    this.logger.log(
      `4DayWeek scrape: search="${input.searchTerm ?? ''}" limit=${limit}`,
    );

    try {
      const http = createHttpClient({
        proxies: input.proxies,
        caCert: input.caCert,
        timeout: input.requestTimeout,
      });

      const response = await http.get<FourDayWeekJob[] | { jobs: FourDayWeekJob[] }>(
        FOURDAYWEEK_API_URL,
        { headers: FOURDAYWEEK_HEADERS },
      );

      const data = response.data;

      // Handle both direct array and object with `jobs` array
      let rawJobs: FourDayWeekJob[];
      if (Array.isArray(data)) {
        rawJobs = data;
      } else if (data && Array.isArray((data as any).jobs)) {
        rawJobs = (data as any).jobs;
      } else {
        this.logger.warn('4DayWeek returned empty or invalid response');
        return new JobResponseDto([]);
      }

      this.logger.log(`4DayWeek returned ${rawJobs.length} raw jobs`);

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
            `Error mapping 4DayWeek job ${entry.id}: ${err.message}`,
          );
        }
      }

      this.logger.log(`4DayWeek mapped ${jobs.length} jobs`);
      return new JobResponseDto(jobs);
    } catch (err: any) {
      this.logger.error(`4DayWeek scrape error: ${err.message}`);
      return new JobResponseDto([], classifyScrapeError(err));
    }
  }

  /**
   * Map a raw 4DayWeek API job object to a JobPostDto.
   */
  private mapJob(
    entry: FourDayWeekJob,
    descriptionFormat?: DescriptionFormat,
  ): JobPostDto | null {
    if (!entry.title || !entry.url) {
      return null;
    }

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

    // Parse compensation from salary_min/salary_max
    const compensation = this.parseCompensation(entry);

    // Parse date
    const datePosted = entry.published_at
      ? entry.published_at.split('T')[0]
      : null;

    return new JobPostDto({
      id: `4dayweek-${entry.id}`,
      title: entry.title,
      companyName: entry.company || null,
      companyLogo: entry.company_logo || null,
      jobUrl: entry.url,
      location,
      description,
      compensation,
      datePosted,
      isRemote: entry.is_remote ?? null,
      emails: extractEmails(description),
      site: Site.FOURDAYWEEK,
      skills: entry.tags && entry.tags.length > 0 ? entry.tags : null,
    });
  }

  /**
   * Build a CompensationDto from salary_min / salary_max fields.
   */
  private parseCompensation(entry: FourDayWeekJob): CompensationDto | null {
    if (entry.salary_min == null && entry.salary_max == null) {
      return null;
    }

    const minAmount = entry.salary_min ?? null;
    const maxAmount = entry.salary_max ?? null;

    if (minAmount == null && maxAmount == null) {
      return null;
    }

    return new CompensationDto({
      interval: CompensationInterval.YEARLY,
      minAmount,
      maxAmount,
      currency: entry.salary_currency || 'USD',
    });
  }
}
