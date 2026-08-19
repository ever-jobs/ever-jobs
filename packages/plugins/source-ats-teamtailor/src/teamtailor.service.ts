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
} from '@ever-jobs/models';
import {
  createHttpClient,
  htmlToPlainText,
  markdownConverter,
  extractEmails,
  toDateOnly,
} from '@ever-jobs/common';
import {
  TEAMTAILOR_API_URL,
  TEAMTAILOR_HEADERS,
  TEAMTAILOR_OFFICIAL_API_URL,
  TEAMTAILOR_API_VERSION,
} from './teamtailor.constants';
import { TeamtailorJob, TeamtailorResponse } from './teamtailor.types';

@SourcePlugin({
  site: Site.TEAMTAILOR,
  name: 'Teamtailor',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class TeamtailorService implements IScraper {
  private readonly logger = new Logger(TeamtailorService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug) {
      this.logger.warn('No companySlug provided for Teamtailor scraper');
      return new JobResponseDto([]);
    }

    // Check for API token: per-request auth overrides env var
    const apiToken =
      input.auth?.teamtailor?.apiToken ?? process.env.TEAMTAILOR_API_TOKEN;
    if (apiToken) {
      try {
        const result = await this.scrapeWithApi(apiToken, companySlug, input);
        return result;
      } catch (err: any) {
        this.logger.warn(
          `Teamtailor authenticated API failed for ${companySlug}: ${err.message}. Falling back to public scraping.`,
        );
      }
    }

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(TEAMTAILOR_HEADERS);

    const url = `${TEAMTAILOR_API_URL}/${encodeURIComponent(companySlug)}`;

    try {
      this.logger.log(`Fetching Teamtailor jobs for company: ${companySlug}`);
      const response = await client.get(url);
      const data: TeamtailorResponse = response.data ?? { data: [] };
      const jobs = data.data ?? [];

      if (!Array.isArray(jobs)) {
        this.logger.warn(`Unexpected Teamtailor response format for ${companySlug}`);
        return new JobResponseDto([]);
      }

      this.logger.log(`Teamtailor: found ${jobs.length} raw jobs for ${companySlug}`);

      const resultsWanted = input.resultsWanted ?? 100;
      const jobPosts: JobPostDto[] = [];

      for (const job of jobs) {
        if (jobPosts.length >= resultsWanted) break;

        try {
          const post = this.processJob(job, companySlug, input.descriptionFormat);
          if (post) {
            jobPosts.push(post);
          }
        } catch (err: any) {
          this.logger.warn(`Error processing Teamtailor job ${job.id}: ${err.message}`);
        }
      }

      return new JobResponseDto(jobPosts);
    } catch (err: any) {
      this.logger.error(`Teamtailor scrape error for ${companySlug}: ${err.message}`);
      return new JobResponseDto([], classifyScrapeError(err));
    }
  }

  /**
   * Fetch jobs using the authenticated Teamtailor JSON:API.
   * Uses Token auth header and reuses processJob() for mapping since
   * the official API returns the same JSON:API structure as the widget.
   */
  private async scrapeWithApi(
    apiToken: string,
    companySlug: string,
    input: ScraperInputDto,
  ): Promise<JobResponseDto> {
    this.logger.log(
      `Teamtailor: using authenticated API for company: ${companySlug}`,
    );

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });

    const resultsWanted = input.resultsWanted ?? 100;
    const pageSize = Math.min(resultsWanted, 30);
    const jobPosts: JobPostDto[] = [];
    let nextUrl: string | null =
      `${TEAMTAILOR_OFFICIAL_API_URL}/jobs?page[size]=${pageSize}`;

    const headers = {
      Accept: 'application/vnd.api+json',
      Authorization: `Token token=${apiToken}`,
      'X-Api-Version': TEAMTAILOR_API_VERSION,
    };

    while (nextUrl && jobPosts.length < resultsWanted) {
      const response = await client.get(nextUrl, { headers });

      const data: TeamtailorResponse = response.data ?? { data: [] };
      const jobs = data.data ?? [];

      if (jobs.length === 0) break;

      this.logger.log(
        `Teamtailor (authenticated): fetched ${jobs.length} jobs for ${companySlug}`,
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
            `Error processing Teamtailor API job ${job.id}: ${err.message}`,
          );
        }
      }

      // Follow JSON:API pagination link
      nextUrl = data.links?.next ?? null;
    }

    this.logger.log(
      `Teamtailor (authenticated) total: ${jobPosts.length} jobs for ${companySlug}`,
    );
    return new JobResponseDto(jobPosts);
  }

  private processJob(
    job: TeamtailorJob,
    companySlug: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const attrs = job.attributes;
    const title = attrs?.title;
    if (!title) return null;

    // Description from body (HTML)
    let description: string | null = null;
    if (attrs.body) {
      if (format === DescriptionFormat.HTML) {
        description = attrs.body;
      } else if (format === DescriptionFormat.MARKDOWN) {
        description = markdownConverter(attrs.body) ?? attrs.body;
      } else {
        description = htmlToPlainText(attrs.body);
      }
    }

    // Location from city/region/country
    const location = new LocationDto({
      city: attrs.city ?? null,
      state: attrs.region ?? null,
      country: attrs.country ?? null,
    });

    // Apply URL
    const applyUrl = attrs['apply-url'] ?? attrs['external-url'] ?? null;

    // Job URL from links
    const jobUrl = job.links?.['careersite-url']
      ?? applyUrl
      ?? `https://career.teamtailor.com/${companySlug}/jobs/${job.id}`;

    // Date posted
    const createdAt = attrs['created-at'] ?? null;
    const datePosted = createdAt
      ? toDateOnly(createdAt)
      : null;

    // Department from relationships
    const departmentId = job.relationships?.department?.data?.id ?? null;

    return new JobPostDto({
      id: `teamtailor-${job.id}`,
      title,
      companyName: companySlug,
      jobUrl,
      location,
      description,
      datePosted,
      isRemote: attrs.remote ?? false,
      emails: extractEmails(description),
      site: Site.TEAMTAILOR,
      // ATS-specific fields
      atsId: job.id,
      atsType: 'teamtailor',
      department: departmentId,
      employmentType: attrs['employment-type'] ?? null,
      applyUrl,
    });
  }
}
