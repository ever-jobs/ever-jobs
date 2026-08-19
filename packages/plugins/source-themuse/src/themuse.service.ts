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
import { THEMUSE_API_URL, THEMUSE_HEADERS } from './themuse.constants';
import { TheMuseResponse, TheMuseJob } from './themuse.types';

@SourcePlugin({
  site: Site.THEMUSE,
  name: 'TheMuse',
  category: 'job-board',
})
@Injectable()
export class TheMuseService implements IScraper {
  private readonly logger = new Logger(TheMuseService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    this.logger.log(
      `TheMuse scrape: search="${input.searchTerm ?? ''}" location="${input.location ?? ''}"`,
    );

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        caCert: input.caCert,
        timeout: input.requestTimeout,
      });
      client.setHeaders(THEMUSE_HEADERS);

      // Build query params
      const params: Record<string, string | number> = {
        page: 0,
        descending: 'true',
      };

      if (input.location) {
        params.location = input.location;
      }

      const response = await client.get<TheMuseResponse>(THEMUSE_API_URL, {
        params,
      });

      const data = response.data;
      if (!data?.results || !Array.isArray(data.results)) {
        this.logger.warn('TheMuse returned empty or invalid response');
        return new JobResponseDto([]);
      }

      this.logger.log(`TheMuse returned ${data.results.length} jobs`);

      let rawJobs = data.results;

      // Filter by search term client-side (TheMuse API has no direct search param)
      if (input.searchTerm) {
        const term = input.searchTerm.toLowerCase();
        rawJobs = rawJobs.filter((job) =>
          (job.name ?? '').toLowerCase().includes(term),
        );
      }

      const jobs: JobPostDto[] = [];

      for (const entry of rawJobs) {
        try {
          const job = this.mapJob(entry, input.descriptionFormat);
          if (job) {
            jobs.push(job);
          }
        } catch (err: any) {
          this.logger.warn(
            `Error mapping TheMuse job ${entry.id}: ${err.message}`,
          );
        }
      }

      return new JobResponseDto(jobs);
    } catch (err: any) {
      this.logger.error(`TheMuse scrape error: ${err.message}`);
      return new JobResponseDto([], classifyScrapeError(err));
    }
  }

  /**
   * Map a raw TheMuse API job object to a JobPostDto.
   */
  private mapJob(
    entry: TheMuseJob,
    descriptionFormat?: DescriptionFormat,
  ): JobPostDto | null {
    if (!entry.name || !entry.refs?.landing_page) {
      return null;
    }

    // Process description (TheMuse returns HTML in contents)
    let description: string | null = entry.contents ?? null;
    if (description) {
      if (descriptionFormat === DescriptionFormat.PLAIN) {
        description = htmlToPlainText(description);
      } else if (descriptionFormat === DescriptionFormat.MARKDOWN) {
        description = markdownConverter(description) ?? description;
      }
    }

    // Build location from first location entry
    const location = this.parseLocation(entry.locations);

    // Parse date (extract date part from ISO 8601)
    const datePosted = entry.publication_date
      ? entry.publication_date.split('T')[0]
      : null;

    return new JobPostDto({
      id: `themuse-${entry.id}`,
      title: entry.name,
      companyName: entry.company?.name ?? null,
      jobUrl: entry.refs.landing_page,
      location,
      description,
      compensation: null,
      datePosted,
      jobLevel: entry.levels?.[0]?.name ?? null,
      emails: extractEmails(description),
      site: Site.THEMUSE,
    });
  }

  /**
   * Parse location from TheMuse locations array.
   * Format is typically "City, State, Country".
   */
  private parseLocation(locations: { name: string }[]): LocationDto {
    if (!locations || locations.length === 0) {
      return new LocationDto({});
    }

    const raw = locations[0].name;
    if (!raw) {
      return new LocationDto({});
    }

    const parts = raw.split(',').map((p) => p.trim());

    return new LocationDto({
      city: parts[0] ?? null,
      state: parts[1] ?? null,
      country: parts[2] ?? null,
    });
  }
}
