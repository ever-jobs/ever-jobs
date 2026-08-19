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
import { createHttpClient, htmlToPlainText, markdownConverter, extractEmails } from '@ever-jobs/common';
import { NODESK_API_URL, NODESK_HEADERS } from './nodesk.constants';
import { NoDeskJob } from './nodesk.types';

@SourcePlugin({
  site: Site.NODESK,
  name: 'NoDesk',
  category: 'remote',
})
@Injectable()
export class NoDeskService implements IScraper {
  private readonly logger = new Logger(NoDeskService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const limit = input.resultsWanted ?? 100;

    this.logger.log(
      `NoDesk scrape: search="${input.searchTerm ?? ''}" limit=${limit}`,
    );

    try {
      const http = createHttpClient({
        proxies: input.proxies,
        caCert: input.caCert,
        timeout: input.requestTimeout,
      });

      const response = await http.get<NoDeskJob[] | { jobs: NoDeskJob[] }>(NODESK_API_URL, {
        headers: NODESK_HEADERS,
      });

      const raw = response.data;

      // Handle both array and { jobs: [...] } response format
      let jobEntries: NoDeskJob[];
      if (Array.isArray(raw)) {
        jobEntries = raw;
      } else if (raw && typeof raw === 'object' && Array.isArray((raw as any).jobs)) {
        jobEntries = (raw as { jobs: NoDeskJob[] }).jobs;
      } else {
        this.logger.warn('NoDesk returned empty or invalid response');
        return new JobResponseDto([]);
      }

      // Filter by searchTerm if provided
      let filtered = jobEntries;
      if (input.searchTerm) {
        const term = input.searchTerm.toLowerCase();
        filtered = jobEntries.filter((job) => {
          const titleMatch = job.title?.toLowerCase().includes(term);
          const tagsMatch = job.tags?.some((tag) =>
            tag.toLowerCase().includes(term),
          );
          return titleMatch || tagsMatch;
        });
      }

      // Limit results
      const limited = filtered.slice(0, limit);

      this.logger.log(
        `NoDesk: ${jobEntries.length} total, ${filtered.length} after filter, returning ${limited.length}`,
      );

      const jobs: JobPostDto[] = [];

      for (const [index, entry] of limited.entries()) {
        try {
          const job = this.mapJob(entry, index, input.descriptionFormat);
          if (job) {
            jobs.push(job);
          }
        } catch (err: any) {
          this.logger.warn(
            `Error mapping NoDesk job ${entry.id ?? index}: ${err.message}`,
          );
        }
      }

      return new JobResponseDto(jobs);
    } catch (err: any) {
      this.logger.error(`NoDesk scrape error: ${err.message}`);
      return new JobResponseDto([], classifyScrapeError(err));
    }
  }

  /**
   * Map a raw NoDesk API job object to a JobPostDto.
   */
  private mapJob(
    entry: NoDeskJob,
    index: number,
    descriptionFormat?: DescriptionFormat,
  ): JobPostDto | null {
    if (!entry.title || !entry.url) {
      return null;
    }

    // Process description (NoDesk may return HTML)
    let description: string | null = entry.description ?? null;
    if (description) {
      if (descriptionFormat === DescriptionFormat.PLAIN) {
        description = htmlToPlainText(description);
      } else if (descriptionFormat === DescriptionFormat.MARKDOWN) {
        description = markdownConverter(description) ?? description;
      }
    }

    // Build location
    const location = new LocationDto({
      city: entry.location || null,
    });

    // Parse date
    const rawDate = entry.published_at || entry.date;
    const datePosted = rawDate ? rawDate.split('T')[0] : null;

    return new JobPostDto({
      id: `nodesk-${entry.id ?? index}`,
      title: entry.title,
      companyName: entry.company || null,
      companyLogo: entry.company_logo || null,
      jobUrl: entry.url,
      location,
      description,
      compensation: null,
      datePosted,
      isRemote: true,
      emails: extractEmails(description),
      site: Site.NODESK,
      skills: entry.tags?.length ? entry.tags : null,
    });
  }
}
