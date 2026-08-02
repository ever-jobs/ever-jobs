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
  ARBEITSAGENTUR_API_URL,
  ARBEITSAGENTUR_HEADERS,
  ARBEITSAGENTUR_DEFAULT_RESULTS,
} from './arbeitsagentur.constants';
import { ArbeitsagenturResponse, ArbeitsagenturJob } from './arbeitsagentur.types';

@SourcePlugin({
  site: Site.ARBEITSAGENTUR,
  name: 'Arbeitsagentur',
  category: 'government',
})
@Injectable()
export class ArbeitsagenturService implements IScraper {
  private readonly logger = new Logger(ArbeitsagenturService.name);
  private readonly apiKey: string | null;

  constructor() {
    this.apiKey = process.env.ARBEITSAGENTUR_API_KEY ?? null;
    if (!this.apiKey) {
      this.logger.warn(
        'ARBEITSAGENTUR_API_KEY not set. Arbeitsagentur searches will return empty results. ' +
          'Get your key at https://jobsuche.api.bund.dev/',
      );
    }
  }

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    if (!this.apiKey) {
      this.logger.warn('Skipping Arbeitsagentur search — API key not configured');
      return new JobResponseDto([]);
    }

    const resultsWanted = input.resultsWanted ?? ARBEITSAGENTUR_DEFAULT_RESULTS;

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders({
      ...ARBEITSAGENTUR_HEADERS,
      'X-API-Key': this.apiKey,
    });

    const params: Record<string, string | number> = {
      size: resultsWanted,
      page: 1,
    };

    if (input.searchTerm) {
      params.was = input.searchTerm;
    }

    if (input.location) {
      params.wo = input.location;
    }

    this.logger.log(
      `Fetching Arbeitsagentur jobs (was="${input.searchTerm ?? ''}", wo="${input.location ?? ''}", size=${resultsWanted})`,
    );

    try {
      const response = await client.get(ARBEITSAGENTUR_API_URL, { params });

      const data = response.data as ArbeitsagenturResponse | undefined;
      const rawJobs = data?.stellenangebote ?? [];

      if (!Array.isArray(rawJobs) || rawJobs.length === 0) {
        this.logger.warn('Arbeitsagentur returned empty or invalid response');
        return new JobResponseDto([]);
      }

      this.logger.log(
        `Arbeitsagentur returned ${rawJobs.length} jobs (total: ${data?.maxErgebnisse ?? 'unknown'})`,
      );

      const jobs: JobPostDto[] = [];

      for (const entry of rawJobs) {
        if (jobs.length >= resultsWanted) break;

        try {
          const job = this.mapJob(entry, input.descriptionFormat);
          if (job) jobs.push(job);
        } catch (err: any) {
          this.logger.warn(
            `Error mapping Arbeitsagentur job ${entry.refnr}: ${err.message}`,
          );
        }
      }

      return new JobResponseDto(jobs);
    } catch (err: any) {
      this.logger.error(`Arbeitsagentur scrape error: ${err.message}`);
      return new JobResponseDto([]);
    }
  }

  /**
   * Map a raw Arbeitsagentur job to a JobPostDto.
   */
  private mapJob(
    entry: ArbeitsagenturJob,
    descriptionFormat?: DescriptionFormat,
  ): JobPostDto | null {
    const title = entry.titel;
    if (!title || !entry.refnr) return null;

    const jobUrl = `https://www.arbeitsagentur.de/jobsuche/suche?id=${entry.refnr}`;

    // Process description from beruf (occupation/role text)
    let description: string | null = entry.beruf ?? null;
    if (description) {
      if (descriptionFormat === DescriptionFormat.PLAIN) {
        description = htmlToPlainText(description);
      } else if (descriptionFormat === DescriptionFormat.MARKDOWN) {
        if (/<[^>]+>/.test(description)) {
          description = markdownConverter(description) ?? description;
        }
      }
    }

    // Build location from arbeitsort
    const arbeitsort = entry.arbeitsort;
    const location = new LocationDto({
      city: arbeitsort?.ort ?? null,
      state: arbeitsort?.region ?? null,
      country: arbeitsort?.land ?? null,
    });

    // Determine if remote from homeOffice flag
    const isRemote = entry.homeOffice ?? false;

    // Parse date from eintrittsdatum or aktuelleVeroeffentlichungsdatum
    let datePosted: string | null = null;
    const rawDate = entry.aktuelleVeroeffentlichungsdatum || entry.eintrittsdatum;
    if (rawDate) {
      try {
        datePosted = toDateOnly(rawDate);
      } catch {
        datePosted = null;
      }
    }

    return new JobPostDto({
      id: `arbeitsagentur-${entry.refnr}`,
      title,
      companyName: entry.arbeitgeber ?? null,
      jobUrl,
      location,
      description,
      compensation: null,
      datePosted,
      jobType: null,
      isRemote,
      emails: extractEmails(description),
      site: Site.ARBEITSAGENTUR,
    });
  }
}
