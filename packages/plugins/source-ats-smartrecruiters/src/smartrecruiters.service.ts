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
  randomSleep,
  htmlToPlainText,
  markdownConverter,
  extractEmails,
  toDateOnly,
} from '@ever-jobs/common';
import {
  SMARTRECRUITERS_API_URL,
  SMARTRECRUITERS_HEADERS,
  SMARTRECRUITERS_PAGE_SIZE,
} from './smartrecruiters.constants';
import { SmartRecruitersJob, SmartRecruitersResponse } from './smartrecruiters.types';

@SourcePlugin({
  site: Site.SMARTRECRUITERS,
  name: 'SmartRecruiters',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class SmartRecruitersService implements IScraper {
  private readonly logger = new Logger(SmartRecruitersService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug) {
      this.logger.warn('No companySlug provided for SmartRecruiters scraper');
      return new JobResponseDto([]);
    }

    // Check for API key: per-request auth overrides env var
    const apiKey =
      input.auth?.smartrecruiters?.apiKey ?? process.env.SMARTRECRUITERS_API_KEY;
    if (apiKey) {
      try {
        const result = await this.scrapeWithApi(apiKey, companySlug, input);
        return result;
      } catch (err: any) {
        this.logger.warn(
          `SmartRecruiters authenticated API failed for ${companySlug}: ${err.message}. Falling back to public scraping.`,
        );
      }
    }

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(SMARTRECRUITERS_HEADERS);

    const resultsWanted = input.resultsWanted ?? 100;
    const jobPosts: JobPostDto[] = [];
    let offset = 0;

    try {
      this.logger.log(`Fetching SmartRecruiters jobs for company: ${companySlug}`);

      while (jobPosts.length < resultsWanted) {
        const url =
          `${SMARTRECRUITERS_API_URL}/${encodeURIComponent(companySlug)}/postings` +
          `?offset=${offset}&limit=${SMARTRECRUITERS_PAGE_SIZE}`;

        const response = await client.get(url);
        const data: SmartRecruitersResponse = response.data ?? { content: [] };
        const jobs = data.content ?? [];

        if (jobs.length === 0) break;

        this.logger.log(
          `SmartRecruiters: fetched ${jobs.length} jobs at offset ${offset} for ${companySlug}`,
        );

        for (const job of jobs) {
          if (jobPosts.length >= resultsWanted) break;

          try {
            const post = this.processJob(job, companySlug, input.descriptionFormat);
            if (post) {
              jobPosts.push(post);
            }
          } catch (err: any) {
            this.logger.warn(
              `Error processing SmartRecruiters job ${job.id}: ${err.message}`,
            );
          }
        }

        offset += jobs.length;

        // If we got less than page size, there are no more results
        if (jobs.length < SMARTRECRUITERS_PAGE_SIZE) break;

        // Delay between pagination requests
        await randomSleep(500, 1500);
      }

      this.logger.log(`SmartRecruiters total: ${jobPosts.length} jobs for ${companySlug}`);
      return new JobResponseDto(jobPosts);
    } catch (err: any) {
      this.logger.error(`SmartRecruiters scrape error for ${companySlug}: ${err.message}`);
      return new JobResponseDto(jobPosts); // Return what we have so far
    }
  }

  /**
   * Fetch jobs using the authenticated SmartRecruiters API.
   * Uses X-SmartToken header auth and reuses processJob() for mapping.
   *
   * @see https://dev.smartrecruiters.com/customer-api/live-docs/
   */
  private async scrapeWithApi(
    apiKey: string,
    companySlug: string,
    input: ScraperInputDto,
  ): Promise<JobResponseDto> {
    this.logger.log(
      `SmartRecruiters: using authenticated API for company: ${companySlug}`,
    );

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });

    const resultsWanted = input.resultsWanted ?? 100;
    const jobPosts: JobPostDto[] = [];
    let offset = 0;

    while (jobPosts.length < resultsWanted) {
      const url =
        `${SMARTRECRUITERS_API_URL}/${encodeURIComponent(companySlug)}/postings` +
        `?offset=${offset}&limit=${SMARTRECRUITERS_PAGE_SIZE}`;

      const response = await client.get(url, {
        headers: {
          Accept: 'application/json',
          'X-SmartToken': apiKey,
        },
      });

      const data: SmartRecruitersResponse = response.data ?? { content: [] };
      const jobs = data.content ?? [];

      if (jobs.length === 0) break;

      this.logger.log(
        `SmartRecruiters (authenticated): fetched ${jobs.length} jobs at offset ${offset} for ${companySlug}`,
      );

      for (const job of jobs) {
        if (jobPosts.length >= resultsWanted) break;

        try {
          const post = this.processJob(job, companySlug, input.descriptionFormat);
          if (post) {
            jobPosts.push(post);
          }
        } catch (err: any) {
          this.logger.warn(
            `Error processing SmartRecruiters API job ${job.id}: ${err.message}`,
          );
        }
      }

      offset += jobs.length;

      // If we got less than page size, there are no more results
      if (jobs.length < SMARTRECRUITERS_PAGE_SIZE) break;

      // Delay between pagination requests
      await randomSleep(500, 1500);
    }

    this.logger.log(
      `SmartRecruiters (authenticated) total: ${jobPosts.length} jobs for ${companySlug}`,
    );
    return new JobResponseDto(jobPosts);
  }

  private processJob(
    job: SmartRecruitersJob,
    companySlug: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const title = job.name;
    if (!title) return null;

    // Location
    const loc = job.location;
    const location = loc
      ? new LocationDto({
          city: loc.city ?? null,
          state: loc.region ?? null,
          country: loc.country ?? null,
        })
      : null;

    const isRemote = loc?.remote ?? false;

    // Date
    const datePosted = job.releasedDate ?? null;

    // Job URL
    const jobUrl =
      job.ref ?? `https://jobs.smartrecruiters.com/${companySlug}/${job.id}`;

    // Description from jobAd sections
    let description: string | null = null;
    const sections = job.jobAd?.sections;
    if (sections) {
      const parts = [
        sections.jobDescription?.text,
        sections.qualifications?.text,
        sections.additionalInformation?.text,
      ].filter(Boolean);

      if (parts.length > 0) {
        const rawHtml = parts.join('\n');
        if (format === DescriptionFormat.HTML) {
          description = rawHtml;
        } else if (format === DescriptionFormat.MARKDOWN) {
          description = markdownConverter(rawHtml) ?? rawHtml;
        } else {
          description = htmlToPlainText(rawHtml);
        }
      }
    }

    return new JobPostDto({
      id: `sr-${job.id}`,
      title,
      companyName: job.company?.name ?? companySlug,
      jobUrl,
      location,
      description,
      datePosted: datePosted
        ? toDateOnly(datePosted)
        : null,
      isRemote,
      emails: extractEmails(description),
      site: Site.SMARTRECRUITERS,
      // ATS-specific fields
      atsId: job.id ?? null,
      atsType: 'smartrecruiters',
      department: job.department?.label ?? null,
      employmentType: job.typeOfEmployment?.label ?? null,
    });
  }
}
