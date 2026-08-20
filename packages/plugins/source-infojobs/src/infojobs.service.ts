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
import { INFOJOBS_API_URL, INFOJOBS_HEADERS, INFOJOBS_DEFAULT_RESULTS } from './infojobs.constants';
import { InfoJobsApiResponse, InfoJobsOffer } from './infojobs.types';

@SourcePlugin({
  site: Site.INFOJOBS,
  name: 'InfoJobs',
  category: 'regional',
})
@Injectable()
export class InfoJobsService implements IScraper {
  private readonly logger = new Logger(InfoJobsService.name);
  private readonly clientId: string | null;
  private readonly clientSecret: string | null;

  constructor() {
    this.clientId = process.env.INFOJOBS_CLIENT_ID ?? null;
    this.clientSecret = process.env.INFOJOBS_CLIENT_SECRET ?? null;
    if (!this.clientId || !this.clientSecret) {
      this.logger.warn(
        'INFOJOBS_CLIENT_ID or INFOJOBS_CLIENT_SECRET is not set. InfoJobs searches will return empty results. ' +
          'Get your credentials at https://developer.infojobs.net/',
      );
    }
  }

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    if (!this.clientId || !this.clientSecret) {
      this.logger.warn('Skipping InfoJobs search — API credentials not configured');
      return new JobResponseDto([]);
    }

    const resultsWanted = input.resultsWanted ?? INFOJOBS_DEFAULT_RESULTS;

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });

    // Basic Auth: base64(clientId:clientSecret)
    const basicToken = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
    client.setHeaders({
      ...INFOJOBS_HEADERS,
      Authorization: `Basic ${basicToken}`,
    });

    const jobs: JobPostDto[] = [];
    let diagnostics: ScrapeDiagnostics | undefined;
    const seenIds = new Set<string>();
    let page = 1;

    while (jobs.length < resultsWanted) {
      // Build query params
      const params: Record<string, string> = {
        page: String(page),
      };

      if (input.searchTerm) {
        params.q = input.searchTerm;
      }
      if (input.location) {
        params.province = input.location;
      }

      const queryString = new URLSearchParams(params).toString();
      const url = queryString ? `${INFOJOBS_API_URL}?${queryString}` : INFOJOBS_API_URL;

      this.logger.log(`Fetching InfoJobs offers: page ${page}`);

      try {
        const response = await client.get(url);
        const data = response.data as InfoJobsApiResponse;

        const rawOffers = data?.items ?? [];
        if (rawOffers.length === 0) {
          this.logger.log('No more InfoJobs offers available');
          break;
        }

        this.logger.log(
          `InfoJobs returned ${rawOffers.length} offers (total: ${data?.totalResults ?? 'unknown'})`,
        );

        for (const raw of rawOffers) {
          if (jobs.length >= resultsWanted) break;

          const jobId = `infojobs-${raw.id}`;
          if (seenIds.has(jobId)) continue;
          seenIds.add(jobId);

          try {
            const job = this.mapJob(raw, input.descriptionFormat);
            if (job) jobs.push(job);
          } catch (err: any) {
            this.logger.warn(`Error mapping InfoJobs offer ${raw.id}: ${err.message}`);
          }
        }

        // Check if there are more pages
        if (page >= (data?.totalPages ?? 0)) break;
        page++;
      } catch (err: any) {
        this.logger.error(`InfoJobs scrape error: ${err.message}`);
        break;
        diagnostics = classifyScrapeError(err);
      }
    }

    this.logger.log(`InfoJobs returned ${jobs.length} jobs`);
    return new JobResponseDto(jobs, diagnostics);
  }

  /**
   * Map a raw InfoJobs offer to a JobPostDto.
   */
  private mapJob(raw: InfoJobsOffer, descriptionFormat?: DescriptionFormat): JobPostDto | null {
    if (!raw.id) return null;
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

    // Build location from province and city
    const provinceName = raw.province?.value ?? null;
    const cityName = raw.city ?? null;
    const location = new LocationDto({
      city: cityName,
      state: provinceName,
    });

    // Determine if remote based on telework-related fields
    const isRemote = raw.telpiOfferType
      ? /remote|teletrabajo|telework/i.test(raw.telpiOfferType)
      : false;

    // Parse date
    let datePosted: string | null = null;
    if (raw.published) {
      try {
        datePosted = toDateOnly(raw.published);
      } catch {
        datePosted = null;
      }
    }

    // Build job URL
    const jobUrl = raw.link || `https://www.infojobs.net/oferta/${raw.id}`;

    return new JobPostDto({
      id: `infojobs-${raw.id}`,
      title: raw.title,
      companyName: raw.company?.name ?? null,
      jobUrl,
      location,
      description,
      compensation: null,
      datePosted,
      jobType: null,
      isRemote,
      emails: extractEmails(description),
      site: Site.INFOJOBS,
    });
  }
}
