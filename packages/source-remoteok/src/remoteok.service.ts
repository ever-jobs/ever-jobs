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
  CompensationInterval,
} from '@ever-jobs/models';
import { createHttpClient, htmlToPlainText, markdownConverter, extractEmails } from '@ever-jobs/common';
import { REMOTEOK_API_URL, REMOTEOK_HEADERS } from './remoteok.constants';
import { RemoteOkJob } from './remoteok.types';

@Injectable()
export class RemoteOkService implements IScraper {
  private readonly logger = new Logger(RemoteOkService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const limit = input.resultsWanted ?? 100;

    this.logger.log(
      `RemoteOK scrape: search="${input.searchTerm ?? ''}" limit=${limit}`,
    );

    try {
      const http = createHttpClient({
        proxies: input.proxies,
        caCert: input.caCert,
        timeout: input.requestTimeout,
      });

      const response = await http.get<unknown[]>(REMOTEOK_API_URL, {
        headers: REMOTEOK_HEADERS,
      });

      const raw = response.data;

      if (!Array.isArray(raw) || raw.length < 2) {
        this.logger.warn('RemoteOK returned empty or invalid response');
        return new JobResponseDto([]);
      }

      // First element is metadata (contains "legal" key), skip it
      const jobEntries = raw.slice(1) as RemoteOkJob[];

      // Filter by searchTerm if provided
      let filtered = jobEntries;
      if (input.searchTerm) {
        const term = input.searchTerm.toLowerCase();
        filtered = jobEntries.filter((job) => {
          const positionMatch = job.position?.toLowerCase().includes(term);
          const tagsMatch = job.tags?.some((tag) =>
            tag.toLowerCase().includes(term),
          );
          return positionMatch || tagsMatch;
        });
      }

      // Limit results
      const limited = filtered.slice(0, limit);

      this.logger.log(
        `RemoteOK: ${jobEntries.length} total, ${filtered.length} after filter, returning ${limited.length}`,
      );

      const jobs: JobPostDto[] = [];

      for (const entry of limited) {
        try {
          const job = this.mapJob(entry, input.descriptionFormat);
          if (job) {
            jobs.push(job);
          }
        } catch (err: any) {
          this.logger.warn(
            `Error mapping RemoteOK job ${entry.id}: ${err.message}`,
          );
        }
      }

      return new JobResponseDto(jobs);
    } catch (err: any) {
      this.logger.error(`RemoteOK scrape error: ${err.message}`);
      return new JobResponseDto([]);
    }
  }

  /**
   * Map a raw RemoteOK API job object to a JobPostDto.
   */
  private mapJob(
    entry: RemoteOkJob,
    descriptionFormat?: DescriptionFormat,
  ): JobPostDto | null {
    if (!entry.position || !entry.url) {
      return null;
    }

    // Process description (RemoteOK returns HTML)
    let description: string | null = entry.description ?? null;
    if (description) {
      if (descriptionFormat === DescriptionFormat.PLAIN) {
        description = htmlToPlainText(description);
      } else if (descriptionFormat === DescriptionFormat.MARKDOWN) {
        description = markdownConverter(description) ?? description;
      }
    }

    // Build compensation if salary data is present
    let compensation: CompensationDto | null = null;
    if (entry.salary_min && entry.salary_max && entry.salary_min > 0 && entry.salary_max > 0) {
      compensation = new CompensationDto({
        interval: CompensationInterval.YEARLY,
        minAmount: entry.salary_min,
        maxAmount: entry.salary_max,
        currency: 'USD',
      });
    }

    // Build location
    const location = new LocationDto({
      city: entry.location || null,
    });

    // Parse date
    const datePosted = entry.date
      ? entry.date.split('T')[0]
      : null;

    return new JobPostDto({
      id: `remoteok-${entry.id}`,
      title: entry.position,
      companyName: entry.company || null,
      companyLogo: entry.company_logo || null,
      jobUrl: entry.url,
      jobUrlDirect: entry.apply_url || null,
      applyUrl: entry.apply_url || null,
      location,
      description,
      compensation,
      datePosted,
      isRemote: true,
      emails: extractEmails(description),
      site: Site.REMOTEOK,
      skills: entry.tags?.length > 0 ? entry.tags : null,
    });
  }
}
