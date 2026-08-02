import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  IScraper,
  ScraperInputDto,
  JobResponseDto,
  JobPostDto,
  LocationDto,
  DescriptionFormat,
  Site,
} from '@ever-jobs/models';
import {
  createHttpClient,
  htmlToPlainText,
  markdownConverter,
  extractEmails,
  toDateOnly,
} from '@ever-jobs/common';
import { DUUNITORI_API_URL, DUUNITORI_DEFAULT_RESULTS, DUUNITORI_HEADERS } from './duunitori.constants';
import { DuunitoriApiResponse, DuunitoriJobEntry } from './duunitori.types';

@SourcePlugin({
  site: Site.DUUNITORI,
  name: 'Duunitori',
  category: 'regional',
})
@Injectable()
export class DuunitoriService implements IScraper {
  private readonly logger = new Logger(DuunitoriService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const resultsWanted = input.resultsWanted ?? DUUNITORI_DEFAULT_RESULTS;

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(DUUNITORI_HEADERS);

    const params: Record<string, string> = {
      format: 'json',
      page: '1',
      page_size: String(resultsWanted),
    };

    if (input.searchTerm) {
      params.search = input.searchTerm;
    }

    const queryString = new URLSearchParams(params).toString();
    const url = `${DUUNITORI_API_URL}?${queryString}`;

    this.logger.log(`Fetching Duunitori jobs: ${DUUNITORI_API_URL}?...`);

    try {
      const response = await client.get(url);
      const data = response.data as DuunitoriApiResponse;

      const rawJobs = data?.results ?? [];
      if (rawJobs.length === 0) {
        this.logger.log('No Duunitori jobs available');
        return new JobResponseDto([]);
      }

      this.logger.log(
        `Duunitori returned ${rawJobs.length} results (total: ${data?.count ?? 'unknown'})`,
      );

      const jobs: JobPostDto[] = [];

      for (const raw of rawJobs) {
        if (jobs.length >= resultsWanted) break;

        try {
          const job = this.mapJob(raw, input.descriptionFormat);
          if (job) jobs.push(job);
        } catch (err: any) {
          this.logger.warn(`Error mapping Duunitori job ${raw.slug}: ${err.message}`);
        }
      }

      this.logger.log(`Duunitori returned ${jobs.length} jobs`);
      return new JobResponseDto(jobs);
    } catch (err: any) {
      this.logger.error(`Duunitori scrape error: ${err.message}`);
      return new JobResponseDto([]);
    }
  }

  /**
   * Map a raw Duunitori job entry to a JobPostDto.
   */
  private mapJob(
    raw: DuunitoriJobEntry,
    descriptionFormat?: DescriptionFormat,
  ): JobPostDto | null {
    if (!raw.heading || !raw.slug) return null;

    // Process description (Duunitori may return HTML)
    let description: string | null = raw.descr ?? null;
    if (description) {
      if (descriptionFormat === DescriptionFormat.PLAIN) {
        description = htmlToPlainText(description);
      } else if (descriptionFormat === DescriptionFormat.MARKDOWN) {
        if (/<[^>]+>/.test(description)) {
          description = markdownConverter(description) ?? description;
        }
      }
    }

    // Build location
    const location = new LocationDto({
      city: raw.municipality_name ?? null,
      country: 'Finland',
    });

    // Parse date to YYYY-MM-DD
    let datePosted: string | null = null;
    if (raw.date_posted) {
      try {
        datePosted = toDateOnly(raw.date_posted);
      } catch {
        datePosted = null;
      }
    }

    return new JobPostDto({
      id: `duunitori-${raw.slug}`,
      title: raw.heading,
      companyName: raw.company_name ?? null,
      jobUrl: `https://duunitori.fi/tyopaikat/${raw.slug}`,
      location,
      description,
      compensation: null,
      datePosted,
      jobType: null,
      isRemote: false,
      emails: extractEmails(description ?? null),
      site: Site.DUUNITORI,
    });
  }
}
