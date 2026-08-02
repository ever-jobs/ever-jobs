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
import { TALROO_API_URL, TALROO_HEADERS, TALROO_DEFAULT_RESULTS, TALROO_MAX_RESULTS } from './talroo.constants';
import { TalrooApiResponse, TalrooJob } from './talroo.types';

@SourcePlugin({
  site: Site.TALROO,
  name: 'Talroo',
  category: 'job-board',
})
@Injectable()
export class TalrooService implements IScraper {
  private readonly logger = new Logger(TalrooService.name);
  private readonly publisherId: string | null;
  private readonly publisherPass: string | null;

  constructor() {
    this.publisherId = process.env.TALROO_PUBLISHER_ID ?? null;
    this.publisherPass = process.env.TALROO_PUBLISHER_PASS ?? null;
    if (!this.publisherId || !this.publisherPass) {
      this.logger.warn(
        'TALROO_PUBLISHER_ID or TALROO_PUBLISHER_PASS is not set. Talroo searches will return empty results. ' +
          'Get your credentials at https://www.talroo.com/',
      );
    }
  }

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    if (!this.publisherId || !this.publisherPass) {
      this.logger.warn('Skipping Talroo search — API credentials not configured');
      return new JobResponseDto([]);
    }

    const resultsWanted = Math.min(
      input.resultsWanted ?? TALROO_DEFAULT_RESULTS,
      TALROO_MAX_RESULTS,
    );

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(TALROO_HEADERS);

    // Build query params
    const params: Record<string, string> = {
      id: this.publisherId,
      pass: this.publisherPass,
      format: 'json',
      full_desc: '1',
      ip: '127.0.0.1',
      limit: String(resultsWanted),
    };

    if (input.searchTerm) {
      params.q = input.searchTerm;
    }
    if (input.location) {
      params.l = input.location;
    }

    const queryString = new URLSearchParams(params).toString();
    const url = `${TALROO_API_URL}?${queryString}`;

    this.logger.log(`Fetching Talroo jobs: ${TALROO_API_URL}?...`);

    try {
      const response = await client.get(url);
      const data = response.data as TalrooApiResponse;

      const rawJobs = data?.jobs ?? [];
      if (rawJobs.length === 0) {
        this.logger.log('No Talroo jobs available');
        return new JobResponseDto([]);
      }

      this.logger.log(
        `Talroo returned ${rawJobs.length} jobs (total: ${data?.total ?? 'unknown'})`,
      );

      const jobs: JobPostDto[] = [];
      const seenIds = new Set<string>();

      for (const raw of rawJobs) {
        if (jobs.length >= resultsWanted) break;

        const jobId = `talroo-${raw.onclick}`;
        if (seenIds.has(jobId)) continue;
        seenIds.add(jobId);

        try {
          const job = this.mapJob(raw, input.descriptionFormat);
          if (job) jobs.push(job);
        } catch (err: any) {
          this.logger.warn(`Error mapping Talroo job: ${err.message}`);
        }
      }

      this.logger.log(`Talroo returned ${jobs.length} jobs`);
      return new JobResponseDto(jobs);
    } catch (err: any) {
      this.logger.error(`Talroo scrape error: ${err.message}`);
      return new JobResponseDto([]);
    }
  }

  /**
   * Map a raw Talroo job to a JobPostDto.
   */
  private mapJob(raw: TalrooJob, descriptionFormat?: DescriptionFormat): JobPostDto | null {
    if (!raw.onclick) return null;
    if (!raw.title) return null;

    // Process description
    let description: string | null = raw.description ?? null;
    if (description) {
      if (descriptionFormat === DescriptionFormat.PLAIN) {
        description = htmlToPlainText(description);
      } else if (descriptionFormat === DescriptionFormat.MARKDOWN) {
        if (/<[^>]+>/.test(description)) {
          description = markdownConverter(description) ?? description;
        }
      }
      // HTML format: pass through as-is
    }

    // Build location from city array
    const cityStr = Array.isArray(raw.city) ? raw.city.join(', ') : (raw.city ?? null);
    const location = new LocationDto({
      city: cityStr,
    });

    // Determine if remote based on city
    const isRemote = Array.isArray(raw.city)
      ? raw.city.some((c) => /remote/i.test(c))
      : typeof raw.city === 'string'
        ? /remote/i.test(raw.city)
        : false;

    // Parse date
    let datePosted: string | null = null;
    if (raw.date) {
      try {
        datePosted = toDateOnly(raw.date);
      } catch {
        datePosted = null;
      }
    }

    return new JobPostDto({
      id: `talroo-${raw.onclick}`,
      title: raw.title,
      companyName: raw.company ?? null,
      jobUrl: raw.onclick,
      location,
      description,
      compensation: null,
      datePosted,
      jobType: null,
      isRemote,
      emails: extractEmails(description),
      site: Site.TALROO,
    });
  }
}
