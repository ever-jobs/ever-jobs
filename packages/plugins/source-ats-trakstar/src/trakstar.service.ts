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
import { TRAKSTAR_HEADERS } from './trakstar.constants';
import { TrakstarJob } from './trakstar.types';

@SourcePlugin({
  site: Site.TRAKSTAR,
  name: 'Trakstar',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class TrakstarService implements IScraper {
  private readonly logger = new Logger(TrakstarService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug) {
      this.logger.warn('No companySlug provided for Trakstar scraper');
      return new JobResponseDto([]);
    }

    // Trakstar Hire API requires authentication (Basic Auth with API key)
    const apiKey =
      input.auth?.trakstar?.apiKey ?? process.env.TRAKSTAR_API_KEY;
    if (!apiKey) {
      this.logger.warn(
        `No API key provided for Trakstar scraper (companySlug: ${companySlug}). ` +
          'Set TRAKSTAR_API_KEY env var or pass auth.trakstar.apiKey in the request.',
      );
      return new JobResponseDto([]);
    }

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });

    // Build Basic Auth header: apiKey as username, empty password
    const basicAuth = Buffer.from(apiKey + ':').toString('base64');
    const headers: Record<string, string> = {
      ...TRAKSTAR_HEADERS,
      Authorization: `Basic ${basicAuth}`,
    };

    const url = `https://${encodeURIComponent(companySlug)}.hire.trakstar.com/api/v1/openings`;

    try {
      this.logger.log(
        `Fetching Trakstar Hire openings for company: ${companySlug}`,
      );
      const response = await client.get(url, { headers });
      const jobs: TrakstarJob[] = Array.isArray(response.data)
        ? response.data
        : [];

      this.logger.log(
        `Trakstar: found ${jobs.length} raw openings for ${companySlug}`,
      );

      const resultsWanted = input.resultsWanted ?? 100;
      const jobPosts: JobPostDto[] = [];

      for (const job of jobs) {
        if (jobPosts.length >= resultsWanted) break;

        try {
          const post = this.processJob(
            job,
            companySlug,
            input.descriptionFormat,
          );
          if (post) {
            jobPosts.push(post);
          }
        } catch (err: any) {
          this.logger.warn(
            `Error processing Trakstar opening ${job.id}: ${err.message}`,
          );
        }
      }

      return new JobResponseDto(jobPosts);
    } catch (err: any) {
      this.logger.error(
        `Trakstar scrape error for ${companySlug}: ${err.message}`,
      );
      return new JobResponseDto([], classifyScrapeError(err));
    }
  }

  private processJob(
    job: TrakstarJob,
    companySlug: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const title = job.title;
    if (!title) return null;

    // Description handling: Trakstar typically returns HTML
    let description: string | null = null;
    if (job.description) {
      if (format === DescriptionFormat.HTML) {
        description = job.description;
      } else if (format === DescriptionFormat.MARKDOWN) {
        description =
          markdownConverter(job.description) ?? job.description;
      } else {
        description = htmlToPlainText(job.description);
      }
    }

    // Location from individual fields or fallback to combined location string
    const location = new LocationDto({
      city: job.city ?? null,
      state: job.state ?? null,
      country: job.country ?? null,
    });
    // If no structured fields but a combined location string exists, use city field
    if (!job.city && !job.state && !job.country && job.location) {
      location.city = job.location;
    }

    // Compensation from salary_min/salary_max
    const compensation = this.extractCompensation(job);

    // Job URL: prefer the API-provided URL, fallback to constructed URL
    const jobUrl =
      job.url ??
      `https://${encodeURIComponent(companySlug)}.hire.trakstar.com/openings/${job.id}`;

    // Date posted
    const datePosted = job.created_at
      ? toDateOnly(job.created_at)
      : null;

    return new JobPostDto({
      id: `trakstar-${job.id}`,
      title,
      companyName: companySlug,
      jobUrl,
      location,
      description,
      compensation,
      datePosted,
      isRemote: job.remote ?? false,
      emails: extractEmails(description),
      site: Site.TRAKSTAR,
      // ATS-specific fields
      atsId: String(job.id),
      atsType: 'trakstar',
      department: job.department ?? null,
      employmentType: job.employment_type ?? null,
      applyUrl: job.apply_url ?? null,
    });
  }

  /**
   * Extract compensation from Trakstar salary fields.
   * Skips if both salary_min and salary_max are null.
   */
  private extractCompensation(job: TrakstarJob): CompensationDto | null {
    if (job.salary_min == null && job.salary_max == null) {
      return null;
    }

    return new CompensationDto({
      interval: CompensationInterval.YEARLY,
      minAmount: job.salary_min ?? undefined,
      maxAmount: job.salary_max ?? undefined,
      currency: job.salary_currency ?? 'USD',
    });
  }
}
