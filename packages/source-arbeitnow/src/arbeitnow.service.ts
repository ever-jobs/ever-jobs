import { Injectable, Logger } from '@nestjs/common';
import {
  IScraper,
  ScraperInputDto,
  JobResponseDto,
  JobPostDto,
  LocationDto,
  CompensationDto,
  Site,
  DescriptionFormat,
  JobType,
  getJobTypeFromString,
} from '@ever-jobs/models';
import {
  createHttpClient,
  htmlToPlainText,
  markdownConverter,
  extractEmails,
} from '@ever-jobs/common';
import { ARBEITNOW_API_URL, ARBEITNOW_HEADERS } from './arbeitnow.constants';
import { ArbeitnowJob, ArbeitnowApiResponse } from './arbeitnow.types';

/** Maximum number of pages to fetch to avoid excessive requests. */
const MAX_PAGES = 3;

@Injectable()
export class ArbeitnowService implements IScraper {
  private readonly logger = new Logger(ArbeitnowService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const resultsWanted = input.resultsWanted ?? 25;

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(ARBEITNOW_HEADERS);

    const jobs: JobPostDto[] = [];
    let page = 1;

    this.logger.log(
      `Fetching Arbeitnow jobs (resultsWanted=${resultsWanted})`,
    );

    try {
      while (jobs.length < resultsWanted && page <= MAX_PAGES) {
        this.logger.log(`Fetching Arbeitnow page ${page}`);

        const response = await client.get<ArbeitnowApiResponse>(
          ARBEITNOW_API_URL,
          { params: { page } },
        );

        const rawJobs = response.data?.data ?? [];
        if (rawJobs.length === 0) {
          this.logger.log('No more jobs returned from Arbeitnow');
          break;
        }

        for (const raw of rawJobs) {
          if (jobs.length >= resultsWanted) break;

          try {
            // Filter by search term if provided
            if (input.searchTerm && !this.matchesSearch(raw, input.searchTerm)) {
              continue;
            }

            const job = this.mapJob(raw, input.descriptionFormat);
            if (job) jobs.push(job);
          } catch (err: any) {
            this.logger.warn(
              `Error mapping Arbeitnow job ${raw.slug}: ${err.message}`,
            );
          }
        }

        // Check if there are more pages
        const hasNext = response.data?.links?.next != null;
        if (!hasNext) break;

        page++;
      }
    } catch (err: any) {
      this.logger.error(`Arbeitnow scrape error: ${err.message}`);
    }

    this.logger.log(`Arbeitnow returned ${jobs.length} jobs`);
    return new JobResponseDto(jobs);
  }

  /**
   * Check whether a job matches the given search term.
   */
  private matchesSearch(raw: ArbeitnowJob, searchTerm: string): boolean {
    const term = searchTerm.toLowerCase();
    const title = (raw.title ?? '').toLowerCase();
    const tags = (raw.tags ?? []).map((t) => t.toLowerCase()).join(' ');
    const description = (raw.description ?? '').toLowerCase();

    return (
      title.includes(term) ||
      tags.includes(term) ||
      description.includes(term)
    );
  }

  /**
   * Map a raw Arbeitnow job to a JobPostDto.
   */
  private mapJob(
    raw: ArbeitnowJob,
    descriptionFormat?: DescriptionFormat,
  ): JobPostDto | null {
    if (!raw.title || !raw.url) return null;

    // Process description (Arbeitnow returns HTML)
    let description: string | null = raw.description ?? null;
    if (description) {
      if (descriptionFormat === DescriptionFormat.PLAIN) {
        description = htmlToPlainText(description);
      } else if (descriptionFormat === DescriptionFormat.MARKDOWN) {
        description = markdownConverter(description) ?? description;
      }
    }

    // Build location
    const location = new LocationDto({
      city: raw.location ?? null,
    });

    // Parse date from Unix timestamp
    let datePosted: string | null = null;
    if (raw.created_at) {
      try {
        datePosted = new Date(raw.created_at * 1000)
          .toISOString()
          .split('T')[0];
      } catch {
        datePosted = null;
      }
    }

    // Map job type from job_types array
    const jobType: JobType[] | null =
      raw.job_types && raw.job_types.length > 0
        ? raw.job_types
            .map((t) => getJobTypeFromString(t))
            .filter((t): t is JobType => t !== null)
        : null;

    return new JobPostDto({
      id: `arbeitnow-${raw.slug}`,
      title: raw.title,
      companyName: raw.company_name ?? null,
      jobUrl: raw.url,
      location,
      description,
      compensation: null,
      datePosted,
      jobType,
      isRemote: raw.remote ?? false,
      emails: extractEmails(description),
      site: Site.ARBEITNOW,
    });
  }
}
