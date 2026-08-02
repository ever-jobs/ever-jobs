import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  IScraper,
  ScraperInputDto,
  JobResponseDto,
  JobPostDto,
  Site,
  DescriptionFormat,
  LocationDto,
} from '@ever-jobs/models';
import {
  createHttpClient,
  htmlToPlainText,
  markdownConverter,
  extractEmails,
  toDateOnly,
} from '@ever-jobs/common';
import { JOBSDB_API_URL, JOBSDB_HEADERS } from './jobsdb.constants';
import { JobsdbJob } from './jobsdb.types';

@SourcePlugin({
  site: Site.JOBSDB,
  name: 'JobsDB',
  category: 'regional',
})
@Injectable()
export class JobsdbService implements IScraper {
  private readonly logger = new Logger(JobsdbService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const resultsWanted = input.resultsWanted ?? 25;
    const searchTerm = input.searchTerm ?? '';
    const location = input.location ?? '';

    const client = createHttpClient(input);
    client.setHeaders(JOBSDB_HEADERS);

    this.logger.log(
      `Searching JobsDB for "${searchTerm}" in "${location}" (resultsWanted=${resultsWanted})`,
    );

    try {
      const jobs: JobPostDto[] = [];
      let page = 1;
      const pageSize = Math.min(resultsWanted, 30);

      while (jobs.length < resultsWanted) {
        const params: Record<string, string | number> = {
          keywords: searchTerm,
          pageSize,
          page,
          siteKey: 'SG-Main', // default to Singapore; covers SG, HK, TH
        };

        if (location) {
          params.where = location;
        }

        const response = await client.get(JOBSDB_API_URL, { params });
        const data = this.parseResponse(response.data);

        if (!data || data.length === 0) {
          this.logger.log(`No more results from JobsDB at page ${page}`);
          break;
        }

        for (const item of data) {
          if (jobs.length >= resultsWanted) break;

          try {
            const job = this.mapJob(item, input.descriptionFormat);
            if (job) jobs.push(job);
          } catch (err: any) {
            this.logger.warn(
              `Error mapping JobsDB job ${item.id}: ${err.message}`,
            );
          }
        }

        page++;
        // Safety: don't paginate more than 10 pages
        if (page > 10) break;
      }

      this.logger.log(`JobsDB returned ${jobs.length} jobs`);
      return new JobResponseDto(jobs);
    } catch (err: any) {
      this.logger.error(`JobsDB scrape error: ${err.message}`);
      return new JobResponseDto([]);
    }
  }

  /**
   * Parse response data from JobsDB API.
   * Handles both direct JSON and string responses.
   */
  private parseResponse(data: any): JobsdbJob[] {
    if (!data) return [];

    // If response is a string, try to parse it
    if (typeof data === 'string') {
      try {
        data = JSON.parse(data);
      } catch {
        this.logger.warn('Failed to parse JobsDB response as JSON');
        return [];
      }
    }

    // The Chalice API returns { data: [...] }
    if (data.data && Array.isArray(data.data)) {
      return data.data as JobsdbJob[];
    }

    // Fallback: if the response itself is an array
    if (Array.isArray(data)) {
      return data as JobsdbJob[];
    }

    return [];
  }

  /**
   * Map a JobsDB API result to a JobPostDto.
   */
  private mapJob(
    item: JobsdbJob,
    descriptionFormat?: DescriptionFormat,
  ): JobPostDto | null {
    if (!item.id || !item.title) return null;

    const jobUrl = item.jobUrl
      ? item.jobUrl.startsWith('http')
        ? item.jobUrl
        : `https://www.jobsdb.com${item.jobUrl}`
      : `https://www.jobsdb.com/job/${item.id}`;

    // Process description
    let description: string | null = item.description ?? item.teaser ?? null;
    if (description) {
      if (descriptionFormat === DescriptionFormat.PLAIN) {
        description = htmlToPlainText(description);
      } else if (descriptionFormat === DescriptionFormat.MARKDOWN) {
        description = markdownConverter(description) ?? description;
      }
    }

    // Parse date
    let datePosted: string | null = null;
    if (item.listingDate) {
      try {
        datePosted = toDateOnly(item.listingDate);
      } catch {
        datePosted = null;
      }
    }

    // Determine remote status
    const isRemote =
      item.isRemote === true ||
      (item.workType ?? '').toLowerCase().includes('remote');

    return new JobPostDto({
      id: `jobsdb-${item.id}`,
      title: item.title,
      jobUrl,
      companyName: item.companyName ?? null,
      location: item.location ? new LocationDto({ city: item.location }) : null,
      description,
      compensation: null,
      datePosted,
      isRemote,
      emails: extractEmails(description ?? null),
      site: Site.JOBSDB,
    });
  }
}
