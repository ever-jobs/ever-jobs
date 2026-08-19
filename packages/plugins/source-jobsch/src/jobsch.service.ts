import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper,
  ScraperInputDto,
  JobResponseDto,
  JobPostDto,
  LocationDto,
  Site,
  DescriptionFormat,
  Country,
} from '@ever-jobs/models';
import {
  createHttpClient,
  htmlToPlainText,
  markdownConverter,
  extractEmails,
  toDateOnly,
} from '@ever-jobs/common';
import { JOBSCH_API_URL, JOBSCH_DEFAULT_RESULTS, JOBSCH_HEADERS } from './jobsch.constants';
import { JobsChDocument, JobsChApiResponse } from './jobsch.types';

@SourcePlugin({
  site: Site.JOBSCH,
  name: 'Jobs.ch',
  category: 'regional',
})
@Injectable()
export class JobsChService implements IScraper {
  private readonly logger = new Logger(JobsChService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const resultsWanted = input.resultsWanted ?? JOBSCH_DEFAULT_RESULTS;

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(JOBSCH_HEADERS);

    this.logger.log(
      `Fetching Jobs.ch jobs (resultsWanted=${resultsWanted}, searchTerm=${input.searchTerm ?? 'none'})`,
    );

    try {
      // Build query params
      const params: Record<string, string | number> = {
        rows: resultsWanted,
      };
      if (input.searchTerm) {
        params.query = input.searchTerm;
      }

      const queryString = Object.entries(params)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join('&');

      const url = `${JOBSCH_API_URL}?${queryString}`;

      this.logger.log(`Requesting: ${url}`);

      const response = await client.get(url);
      const data = response.data as JobsChApiResponse;

      if (!data || !data.documents || !Array.isArray(data.documents)) {
        this.logger.warn('Empty or invalid response from Jobs.ch');
        return new JobResponseDto([]);
      }

      this.logger.log(
        `Jobs.ch returned ${data.documents.length} documents (total pages: ${data.num_pages})`,
      );

      const jobs: JobPostDto[] = [];

      for (const doc of data.documents) {
        if (jobs.length >= resultsWanted) break;

        try {
          const job = this.mapJob(doc, input.descriptionFormat);
          if (job) jobs.push(job);
        } catch (err: any) {
          this.logger.warn(
            `Error mapping Jobs.ch job ${doc.job_id}: ${err.message}`,
          );
        }
      }

      this.logger.log(`Jobs.ch returned ${jobs.length} jobs`);
      return new JobResponseDto(jobs);
    } catch (err: any) {
      this.logger.error(`Jobs.ch scrape error: ${err.message}`);
      return new JobResponseDto([], classifyScrapeError(err));
    }
  }

  /**
   * Map a Jobs.ch document to a JobPostDto.
   */
  private mapJob(
    doc: JobsChDocument,
    descriptionFormat?: DescriptionFormat,
  ): JobPostDto | null {
    if (!doc.title || !doc.job_id) return null;

    // Build job URL from _links or fallback
    const jobUrl =
      doc._links?.detail_en?.href ??
      `https://www.jobs.ch/en/vacancies/detail/${doc.job_id}/`;

    // Process description (preview may contain HTML)
    let description: string | null = doc.preview ?? null;
    if (description) {
      if (descriptionFormat === DescriptionFormat.PLAIN) {
        description = htmlToPlainText(description);
      } else if (descriptionFormat === DescriptionFormat.MARKDOWN) {
        description = markdownConverter(description) ?? description;
      }
    }

    // Parse date to YYYY-MM-DD
    let datePosted: string | null = null;
    if (doc.publication_date) {
      try {
        datePosted = toDateOnly(doc.publication_date);
      } catch {
        datePosted = null;
      }
    }

    return new JobPostDto({
      id: `jobsch-${doc.job_id}`,
      title: doc.title,
      jobUrl,
      companyName: doc.company_name ?? null,
      location: new LocationDto({ country: Country.SWITZERLAND }),
      description,
      compensation: null,
      datePosted,
      jobType: null,
      isRemote: false,
      emails: extractEmails(description ?? null),
      site: Site.JOBSCH,
    });
  }
}
