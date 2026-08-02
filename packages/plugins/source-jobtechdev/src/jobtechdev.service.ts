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
import { JOBTECHDEV_API_URL, JOBTECHDEV_HEADERS, JOBTECHDEV_DEFAULT_RESULTS, JOBTECHDEV_MAX_RESULTS } from './jobtechdev.constants';
import { JobTechDevResponse, JobTechDevHit } from './jobtechdev.types';

@SourcePlugin({
  site: Site.JOBTECHDEV,
  name: 'JobTechDev',
  category: 'government',
})
@Injectable()
export class JobTechDevService implements IScraper {
  private readonly logger = new Logger(JobTechDevService.name);
  private readonly apiKey: string | null;

  constructor() {
    this.apiKey = process.env.JOBTECHDEV_API_KEY ?? null;
    if (!this.apiKey) {
      this.logger.warn(
        'JOBTECHDEV_API_KEY is not set. JobTech Dev searches will return empty results. ' +
          'Get a free API key at https://apirequest.jobtechdev.se/',
      );
    }
  }

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    if (!this.apiKey) {
      this.logger.warn('Skipping JobTech Dev search — API key not configured');
      return new JobResponseDto([]);
    }

    const resultsWanted = Math.min(
      input.resultsWanted ?? JOBTECHDEV_DEFAULT_RESULTS,
      JOBTECHDEV_MAX_RESULTS,
    );

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders({ ...JOBTECHDEV_HEADERS, 'api-key': this.apiKey });

    const params: Record<string, string> = {
      limit: String(resultsWanted),
      offset: '0',
    };

    if (input.searchTerm) {
      params.q = input.searchTerm;
    }
    if (input.location) {
      params.q = params.q ? `${params.q} ${input.location}` : input.location;
    }

    const queryString = new URLSearchParams(params).toString();
    const url = `${JOBTECHDEV_API_URL}?${queryString}`;

    this.logger.log(`Fetching JobTech Dev jobs: ${JOBTECHDEV_API_URL}?...`);

    try {
      const response = await client.get(url);
      const data = response.data as JobTechDevResponse;

      const hits = data?.hits ?? [];
      if (hits.length === 0) {
        this.logger.log('No JobTech Dev jobs available');
        return new JobResponseDto([]);
      }

      this.logger.log(
        `JobTech Dev returned ${hits.length} hits (total: ${data?.total?.value ?? 'unknown'})`,
      );

      const jobs: JobPostDto[] = [];

      for (const hit of hits) {
        if (jobs.length >= resultsWanted) break;

        try {
          const job = this.mapJob(hit, input.descriptionFormat);
          if (job) jobs.push(job);
        } catch (err: any) {
          this.logger.warn(`Error mapping JobTech Dev job ${hit.id}: ${err.message}`);
        }
      }

      this.logger.log(`JobTech Dev returned ${jobs.length} jobs`);
      return new JobResponseDto(jobs);
    } catch (err: any) {
      this.logger.error(`JobTech Dev scrape error: ${err.message}`);
      return new JobResponseDto([]);
    }
  }

  private mapJob(hit: JobTechDevHit, descriptionFormat?: DescriptionFormat): JobPostDto | null {
    if (!hit.headline) return null;

    const jobUrl = hit.webpage_url ?? hit.application_details?.url ?? null;
    if (!jobUrl) return null;

    let description: string | null = hit.description?.text ?? null;
    if (description) {
      if (descriptionFormat === DescriptionFormat.PLAIN) {
        description = htmlToPlainText(description);
      } else if (descriptionFormat === DescriptionFormat.MARKDOWN) {
        if (/<[^>]+>/.test(description)) {
          description = markdownConverter(description) ?? description;
        }
      }
    }

    const location = new LocationDto({
      city: hit.workplace_address?.municipality ?? null,
      state: hit.workplace_address?.region ?? null,
      country: hit.workplace_address?.country ?? 'Sweden',
    });

    let datePosted: string | null = null;
    if (hit.publication_date) {
      try {
        datePosted = toDateOnly(hit.publication_date);
      } catch {
        datePosted = null;
      }
    }

    return new JobPostDto({
      id: `jobtechdev-${hit.id}`,
      title: hit.headline,
      companyName: hit.employer?.name ?? null,
      companyLogo: hit.logo_url ?? null,
      jobUrl,
      location,
      description,
      compensation: null,
      datePosted,
      isRemote: false,
      emails: extractEmails(description),
      site: Site.JOBTECHDEV,
    });
  }
}
