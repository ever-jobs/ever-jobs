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
import {
  CAREERONESTOP_API_URL,
  CAREERONESTOP_HEADERS,
  CAREERONESTOP_DEFAULT_RADIUS,
  CAREERONESTOP_DEFAULT_RESULTS,
} from './careeronestop.constants';
import { CareerOneStopResponse, CareerOneStopJob } from './careeronestop.types';

@SourcePlugin({
  site: Site.CAREERONESTOP,
  name: 'CareerOneStop',
  category: 'government',
})
@Injectable()
export class CareerOneStopService implements IScraper {
  private readonly logger = new Logger(CareerOneStopService.name);
  private readonly apiKey: string | null;
  private readonly userId: string;

  constructor() {
    this.apiKey = process.env.CAREERONESTOP_API_KEY ?? null;
    this.userId = process.env.CAREERONESTOP_USER_ID ?? 'anonymous';
    if (!this.apiKey) {
      this.logger.warn(
        'CAREERONESTOP_API_KEY not set. CareerOneStop searches will return empty results. ' +
          'Get your key at https://www.careeronestop.org/Developers/WebAPI/registration.aspx',
      );
    }
  }

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    if (!this.apiKey) {
      this.logger.warn('Skipping CareerOneStop search — API key not configured');
      return new JobResponseDto([]);
    }

    const resultsWanted = input.resultsWanted ?? CAREERONESTOP_DEFAULT_RESULTS;
    const keyword = encodeURIComponent(input.searchTerm ?? '');
    const location = encodeURIComponent(input.location ?? '');
    const radius = CAREERONESTOP_DEFAULT_RADIUS;
    const sortColumns = 'relevance';
    const sortOrder = 'asc';
    const startRecord = 0;
    const pageSize = resultsWanted;
    const days = 0;

    const url =
      `${CAREERONESTOP_API_URL}/${this.userId}/${keyword}/${location}/${radius}` +
      `/${sortColumns}/${sortOrder}/${startRecord}/${pageSize}/${days}`;

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders({
      ...CAREERONESTOP_HEADERS,
      Authorization: `Bearer ${this.apiKey}`,
    });

    this.logger.log(
      `Fetching CareerOneStop jobs (keyword="${input.searchTerm ?? ''}", location="${input.location ?? ''}", pageSize=${pageSize})`,
    );

    try {
      const response = await client.get(url);

      const data = response.data as CareerOneStopResponse | undefined;
      if (!data?.Jobs || !Array.isArray(data.Jobs)) {
        this.logger.warn('CareerOneStop returned empty or invalid response');
        return new JobResponseDto([]);
      }

      this.logger.log(
        `CareerOneStop returned ${data.Jobs.length} jobs (total: ${data.RecordCount ?? 'unknown'})`,
      );

      const jobs: JobPostDto[] = [];

      for (const entry of data.Jobs) {
        if (jobs.length >= resultsWanted) break;

        try {
          const job = this.mapJob(entry, input.descriptionFormat);
          if (job) jobs.push(job);
        } catch (err: any) {
          this.logger.warn(
            `Error mapping CareerOneStop job ${entry.JvId}: ${err.message}`,
          );
        }
      }

      return new JobResponseDto(jobs);
    } catch (err: any) {
      this.logger.error(`CareerOneStop scrape error: ${err.message}`);
      return new JobResponseDto([]);
    }
  }

  /**
   * Map a raw CareerOneStop job to a JobPostDto.
   */
  private mapJob(
    entry: CareerOneStopJob,
    descriptionFormat?: DescriptionFormat,
  ): JobPostDto | null {
    const title = entry.Title || entry.JvId;
    const jobUrl = entry.URL;
    if (!title || !jobUrl) return null;

    // Process description
    let description: string | null = entry.Description ?? null;
    if (description) {
      if (descriptionFormat === DescriptionFormat.PLAIN) {
        description = htmlToPlainText(description);
      } else if (descriptionFormat === DescriptionFormat.MARKDOWN) {
        if (/<[^>]+>/.test(description)) {
          description = markdownConverter(description) ?? description;
        }
      }
    }

    // Parse location (format is typically "City, State")
    const location = this.parseLocation(entry.Location);

    // Check if remote
    const isRemote = entry.Location
      ? /remote/i.test(entry.Location)
      : false;

    // Parse date
    let datePosted: string | null = null;
    if (entry.DatePosted) {
      try {
        datePosted = toDateOnly(entry.DatePosted);
      } catch {
        datePosted = null;
      }
    }

    return new JobPostDto({
      id: `careeronestop-${entry.JvId}`,
      title,
      companyName: entry.Company ?? null,
      jobUrl,
      location,
      description,
      compensation: null,
      datePosted,
      jobType: null,
      isRemote,
      emails: extractEmails(description),
      site: Site.CAREERONESTOP,
    });
  }

  /**
   * Parse a location string like "City, State" into a LocationDto.
   */
  private parseLocation(locationStr: string | null | undefined): LocationDto {
    if (!locationStr) {
      return new LocationDto({});
    }

    const parts = locationStr.split(',').map((p) => p.trim());
    return new LocationDto({
      city: parts[0] || null,
      state: parts[1] || null,
    });
  }
}
