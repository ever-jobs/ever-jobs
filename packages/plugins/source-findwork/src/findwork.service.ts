import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  ScrapeDiagnostics,
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
import { FINDWORK_API_URL, FINDWORK_HEADERS, FINDWORK_DEFAULT_RESULTS } from './findwork.constants';
import { FindWorkApiResponse, FindWorkJob } from './findwork.types';

@SourcePlugin({
  site: Site.FINDWORK,
  name: 'FindWork',
  category: 'niche',
})
@Injectable()
export class FindWorkService implements IScraper {
  private readonly logger = new Logger(FindWorkService.name);
  private readonly defaultApiKey: string | null;

  constructor() {
    this.defaultApiKey = process.env.FINDWORK_API_KEY ?? null;
    if (!this.defaultApiKey) {
      this.logger.warn(
        'FINDWORK_API_KEY is not set. FindWork searches will return empty results. ' +
          'Get your key at https://findwork.dev/developers/',
      );
    }
  }

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const apiKey = this.defaultApiKey;

    if (!apiKey) {
      this.logger.warn('Skipping FindWork search — API key not configured');
      return new JobResponseDto([]);
    }

    const resultsWanted = input.resultsWanted ?? FINDWORK_DEFAULT_RESULTS;

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders({
      ...FINDWORK_HEADERS,
      Authorization: `Token ${apiKey}`,
    });

    const jobs: JobPostDto[] = [];
    let diagnostics: ScrapeDiagnostics | undefined;
    const seenIds = new Set<string>();
    let nextUrl: string | null = null;
    let isFirstPage = true;

    while (jobs.length < resultsWanted) {
      let url: string;

      if (isFirstPage) {
        // Build initial URL with query params
        const params: Record<string, string> = {};
        if (input.searchTerm) {
          params.search = input.searchTerm;
        }
        if (input.location) {
          params.location = input.location;
        }
        params.sort_by = 'relevance';

        const queryString = new URLSearchParams(params).toString();
        url = queryString ? `${FINDWORK_API_URL}?${queryString}` : FINDWORK_API_URL;
        isFirstPage = false;
      } else if (nextUrl) {
        url = nextUrl;
      } else {
        break;
      }

      this.logger.log(`Fetching FindWork jobs: ${url}`);

      try {
        const response = await client.get(url);
        const data = response.data as FindWorkApiResponse;

        const rawJobs = data?.results ?? [];
        if (rawJobs.length === 0) {
          this.logger.log('No more FindWork jobs available');
          break;
        }

        this.logger.log(
          `FindWork returned ${rawJobs.length} jobs (total: ${data?.count ?? 'unknown'})`,
        );

        for (const raw of rawJobs) {
          if (jobs.length >= resultsWanted) break;

          const jobId = `findwork-${raw.id}`;
          if (seenIds.has(jobId)) continue;
          seenIds.add(jobId);

          try {
            const job = this.mapJob(raw, input.descriptionFormat);
            if (job) jobs.push(job);
          } catch (err: any) {
            this.logger.warn(`Error mapping FindWork job ${raw.id}: ${err.message}`);
          }
        }

        nextUrl = data?.next ?? null;
        if (!nextUrl) break;
      } catch (err: any) {
        this.logger.error(`FindWork scrape error: ${err.message}`);
        break;
        diagnostics = classifyScrapeError(err);
      }
    }

    this.logger.log(`FindWork returned ${jobs.length} jobs`);
    return new JobResponseDto(jobs, diagnostics);
  }

  /**
   * Map a raw FindWork job to a JobPostDto.
   */
  private mapJob(raw: FindWorkJob, descriptionFormat?: DescriptionFormat): JobPostDto | null {
    if (!raw.url) return null;
    if (!raw.role) return null;

    // Process description (FindWork may return HTML fragments)
    let description: string | null = raw.text ?? null;
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

    // Build location
    const location = new LocationDto({
      city: raw.location ?? null,
    });

    // Parse date
    let datePosted: string | null = null;
    if (raw.date_posted) {
      try {
        datePosted = toDateOnly(raw.date_posted);
      } catch {
        datePosted = null;
      }
    }

    return new JobPostDto({
      id: `findwork-${raw.id}`,
      title: raw.role,
      companyName: raw.company_name ?? null,
      jobUrl: raw.url,
      location,
      description,
      compensation: null,
      datePosted,
      jobType: null,
      isRemote: raw.remote ?? false,
      emails: extractEmails(description),
      skills: raw.keywords ?? null,
      site: Site.FINDWORK,
    });
  }
}
