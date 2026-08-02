import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  IScraper,
  ScraperInputDto,
  JobResponseDto,
  JobPostDto,
  LocationDto,
  CompensationDto,
  CompensationInterval,
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
import { GETONBOARD_API_URL, GETONBOARD_HEADERS, GETONBOARD_DEFAULT_RESULTS, GETONBOARD_MAX_RESULTS } from './getonboard.constants';
import { GetOnBoardSearchResponse, GetOnBoardJob } from './getonboard.types';

@SourcePlugin({
  site: Site.GETONBOARD,
  name: 'GetOnBoard',
  category: 'regional',
})
@Injectable()
export class GetOnBoardService implements IScraper {
  private readonly logger = new Logger(GetOnBoardService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const resultsWanted = Math.min(
      input.resultsWanted ?? GETONBOARD_DEFAULT_RESULTS,
      GETONBOARD_MAX_RESULTS,
    );

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(GETONBOARD_HEADERS);

    const params: Record<string, string> = {
      per_page: String(Math.min(resultsWanted, 50)),
      page: '1',
    };

    if (input.searchTerm) {
      params.query = input.searchTerm;
    }

    const queryString = new URLSearchParams(params).toString();
    const url = `${GETONBOARD_API_URL}?${queryString}`;

    this.logger.log(`Fetching Get on Board jobs: ${GETONBOARD_API_URL}?...`);

    try {
      const response = await client.get(url);
      const data = response.data as GetOnBoardSearchResponse;

      const rawJobs = data?.data ?? [];
      if (rawJobs.length === 0) {
        this.logger.log('No Get on Board jobs available');
        return new JobResponseDto([]);
      }

      this.logger.log(`Get on Board returned ${rawJobs.length} jobs`);

      const jobs: JobPostDto[] = [];

      for (const raw of rawJobs) {
        if (jobs.length >= resultsWanted) break;

        try {
          const job = this.mapJob(raw, input.descriptionFormat);
          if (job) jobs.push(job);
        } catch (err: any) {
          this.logger.warn(`Error mapping Get on Board job ${raw.id}: ${err.message}`);
        }
      }

      this.logger.log(`Get on Board returned ${jobs.length} jobs`);
      return new JobResponseDto(jobs);
    } catch (err: any) {
      this.logger.error(`Get on Board scrape error: ${err.message}`);
      return new JobResponseDto([]);
    }
  }

  private mapJob(raw: GetOnBoardJob, descriptionFormat?: DescriptionFormat): JobPostDto | null {
    const attrs = raw.attributes;
    if (!attrs.title || !raw.links?.public_url) return null;

    let description: string | null = attrs.description ?? null;
    if (description) {
      if (descriptionFormat === DescriptionFormat.PLAIN) {
        description = htmlToPlainText(description);
      } else if (descriptionFormat === DescriptionFormat.MARKDOWN) {
        if (/<[^>]+>/.test(description)) {
          description = markdownConverter(description) ?? description;
        }
      }
    }

    let compensation: CompensationDto | null = null;
    if (attrs.min_salary || attrs.max_salary) {
      compensation = new CompensationDto({
        interval: CompensationInterval.YEARLY,
        minAmount: attrs.min_salary ?? null,
        maxAmount: attrs.max_salary ?? null,
        currency: 'USD',
      });
    }

    const cityStr = attrs.location_cities?.join(', ') ?? null;
    const countryStr = attrs.countries?.join(', ') ?? null;
    const location = new LocationDto({
      city: cityStr,
      country: countryStr,
    });

    let datePosted: string | null = null;
    if (attrs.published_at) {
      try {
        datePosted = toDateOnly(attrs.published_at * 1000);
      } catch {
        datePosted = null;
      }
    }

    return new JobPostDto({
      id: `getonboard-${raw.id}`,
      title: attrs.title,
      companyName: attrs.company ?? null,
      companyLogo: attrs.logo ?? null,
      jobUrl: raw.links.public_url,
      location,
      description,
      compensation,
      datePosted,
      isRemote: attrs.remote ?? false,
      emails: extractEmails(description),
      site: Site.GETONBOARD,
    });
  }
}
