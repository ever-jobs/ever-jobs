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
  CompensationInterval,
  DescriptionFormat,
  Site,
} from '@ever-jobs/models';
import {
  createHttpClient,
  extractEmails,
  toDateOnly,
} from '@ever-jobs/common';
import {
  CANADAJOBBANK_API_URL,
  CANADAJOBBANK_RESOURCE_ID,
  CANADAJOBBANK_HEADERS,
  CANADAJOBBANK_DEFAULT_RESULTS,
  CANADAJOBBANK_MAX_RESULTS,
} from './canadajobbank.constants';
import { CanadaJobBankResponse, CanadaJobBankRecord } from './canadajobbank.types';

@SourcePlugin({
  site: Site.CANADAJOBBANK,
  name: 'CanadaJobBank',
  category: 'government',
})
@Injectable()
export class CanadaJobBankService implements IScraper {
  private readonly logger = new Logger(CanadaJobBankService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const resultsWanted = Math.min(
      input.resultsWanted ?? CANADAJOBBANK_DEFAULT_RESULTS,
      CANADAJOBBANK_MAX_RESULTS,
    );

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(CANADAJOBBANK_HEADERS);

    const params: Record<string, string> = {
      resource_id: CANADAJOBBANK_RESOURCE_ID,
      limit: String(resultsWanted),
    };

    if (input.searchTerm) {
      params.q = input.searchTerm;
    }

    const queryString = new URLSearchParams(params).toString();
    const url = `${CANADAJOBBANK_API_URL}?${queryString}`;

    this.logger.log(`Fetching Canada Job Bank: ${CANADAJOBBANK_API_URL}?...`);

    try {
      const response = await client.get(url);
      const data = response.data as CanadaJobBankResponse;

      if (!data?.success) {
        this.logger.warn('Canada Job Bank API returned unsuccessful response');
        return new JobResponseDto([]);
      }

      const records = data?.result?.records ?? [];
      if (records.length === 0) {
        this.logger.log('No Canada Job Bank records available');
        return new JobResponseDto([]);
      }

      this.logger.log(
        `Canada Job Bank returned ${records.length} records (total: ${data?.result?.total ?? 'unknown'})`,
      );

      const jobs: JobPostDto[] = [];

      for (const record of records) {
        if (jobs.length >= resultsWanted) break;

        try {
          const job = this.mapJob(record);
          if (job) jobs.push(job);
        } catch (err: any) {
          this.logger.warn(`Error mapping Canada Job Bank record ${record._id}: ${err.message}`);
        }
      }

      this.logger.log(`Canada Job Bank returned ${jobs.length} jobs`);
      return new JobResponseDto(jobs);
    } catch (err: any) {
      this.logger.error(`Canada Job Bank scrape error: ${err.message}`);
      return new JobResponseDto([], classifyScrapeError(err));
    }
  }

  private mapJob(record: CanadaJobBankRecord): JobPostDto | null {
    const title = record['Job Title'] ?? record['Original Job Title'];
    if (!title) return null;

    const jobUrl = `https://www.jobbank.gc.ca/jobsearch/jobposting/${record._id}`;

    const description = [
      record['NOC21 Code Name'] ? `Occupation: ${record['NOC21 Code Name']}` : null,
      record['Employment Type'] ? `Type: ${record['Employment Type']}` : null,
      record['Employment Term'] ? `Term: ${record['Employment Term']}` : null,
      record['Education LOS'] ? `Education: ${record['Education LOS']}` : null,
      record['Experience Level'] ? `Experience: ${record['Experience Level']}` : null,
      record['Vacancy Count'] ? `Vacancies: ${record['Vacancy Count']}` : null,
    ].filter(Boolean).join('\n') || null;

    let compensation: CompensationDto | null = null;
    if (record['Salary Minimum'] || record['Salary Maximum']) {
      const salaryPer = (record['Salary Per'] ?? '').toLowerCase();
      let interval = CompensationInterval.YEARLY;
      if (salaryPer === 'hour' || salaryPer === 'hourly') {
        interval = CompensationInterval.HOURLY;
      }

      compensation = new CompensationDto({
        interval,
        minAmount: record['Salary Minimum'] ?? null,
        maxAmount: record['Salary Maximum'] ?? null,
        currency: 'CAD',
      });
    }

    const location = new LocationDto({
      city: record.City ?? null,
      state: record['Province/Territory'] ?? null,
      country: 'Canada',
    });

    let datePosted: string | null = null;
    if (record['First Posting Date']) {
      try {
        datePosted = toDateOnly(record['First Posting Date']);
      } catch {
        datePosted = null;
      }
    }

    return new JobPostDto({
      id: `canadajobbank-${record._id}`,
      title,
      jobUrl,
      location,
      description,
      compensation,
      datePosted,
      isRemote: false,
      emails: extractEmails(description),
      site: Site.CANADAJOBBANK,
    });
  }
}
