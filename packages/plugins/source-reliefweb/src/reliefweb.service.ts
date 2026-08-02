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
import {
  RELIEFWEB_API_URL,
  RELIEFWEB_APP_NAME,
  RELIEFWEB_HEADERS,
  RELIEFWEB_DEFAULT_RESULTS,
  RELIEFWEB_MAX_RESULTS,
  RELIEFWEB_FIELDS,
} from './reliefweb.constants';
import { ReliefWebResponse, ReliefWebJobEntry } from './reliefweb.types';

@SourcePlugin({
  site: Site.RELIEFWEB,
  name: 'ReliefWeb',
  category: 'niche',
})
@Injectable()
export class ReliefWebService implements IScraper {
  private readonly logger = new Logger(ReliefWebService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const resultsWanted = Math.min(
      input.resultsWanted ?? RELIEFWEB_DEFAULT_RESULTS,
      RELIEFWEB_MAX_RESULTS,
    );

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(RELIEFWEB_HEADERS);

    const params = new URLSearchParams({
      appname: RELIEFWEB_APP_NAME,
      limit: String(resultsWanted),
      offset: '0',
    });

    for (const field of RELIEFWEB_FIELDS) {
      params.append('fields[include][]', field);
    }

    if (input.searchTerm) {
      params.set('query[value]', input.searchTerm);
    }

    const url = `${RELIEFWEB_API_URL}?${params.toString()}`;

    this.logger.log(`Fetching ReliefWeb jobs: ${RELIEFWEB_API_URL}?...`);

    try {
      const response = await client.get(url);
      const data = response.data as ReliefWebResponse;

      const entries = data?.data ?? [];
      if (entries.length === 0) {
        this.logger.log('No ReliefWeb jobs available');
        return new JobResponseDto([]);
      }

      this.logger.log(`ReliefWeb returned ${entries.length} jobs`);

      const jobs: JobPostDto[] = [];

      for (const entry of entries) {
        if (jobs.length >= resultsWanted) break;

        try {
          const job = this.mapJob(entry, input.descriptionFormat);
          if (job) jobs.push(job);
        } catch (err: any) {
          this.logger.warn(`Error mapping ReliefWeb job ${entry.id}: ${err.message}`);
        }
      }

      this.logger.log(`ReliefWeb returned ${jobs.length} jobs`);
      return new JobResponseDto(jobs);
    } catch (err: any) {
      this.logger.error(`ReliefWeb scrape error: ${err.message}`);
      return new JobResponseDto([]);
    }
  }

  private mapJob(entry: ReliefWebJobEntry, descriptionFormat?: DescriptionFormat): JobPostDto | null {
    const fields = entry.fields;
    if (!fields.title) return null;

    const jobUrl = fields.url ?? entry.href;

    let description: string | null = fields.body ?? null;
    if (description) {
      if (descriptionFormat === DescriptionFormat.PLAIN) {
        description = htmlToPlainText(description);
      } else if (descriptionFormat === DescriptionFormat.MARKDOWN) {
        if (/<[^>]+>/.test(description)) {
          description = markdownConverter(description) ?? description;
        }
      }
    }

    const companyName = fields.source?.[0]?.name ?? null;

    const countries = fields.country?.map(c => c.name) ?? [];
    const location = new LocationDto({
      country: countries[0] ?? null,
      city: countries.length > 1 ? countries.join(', ') : null,
    });

    let datePosted: string | null = null;
    if (fields.date?.created) {
      try {
        datePosted = toDateOnly(fields.date.created);
      } catch {
        datePosted = null;
      }
    }

    return new JobPostDto({
      id: `reliefweb-${entry.id}`,
      title: fields.title,
      companyName,
      jobUrl,
      location,
      description,
      compensation: undefined,
      datePosted,
      isRemote: false,
      emails: extractEmails(description ?? null),
      site: Site.RELIEFWEB,
    });
  }
}
