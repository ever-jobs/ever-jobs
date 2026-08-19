import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper,
  ScraperInputDto,
  JobResponseDto,
  JobPostDto,
  Site,
  DescriptionFormat,
  LocationDto,
} from '@ever-jobs/models';
import {
  createHttpClient,
  htmlToPlainText,
  markdownConverter,
  extractEmails,
  toDateOnly,
} from '@ever-jobs/common';
import { TECHCAREERS_SEARCH_URL, TECHCAREERS_HEADERS } from './techcareers.constants';
import { TechcareersJob } from './techcareers.types';

@SourcePlugin({
  site: Site.TECHCAREERS,
  name: 'TechCareers',
  category: 'niche',
})
@Injectable()
export class TechcareersService implements IScraper {
  private readonly logger = new Logger(TechcareersService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const resultsWanted = input.resultsWanted ?? 25;
    const searchTerm = input.searchTerm ?? '';
    const location = input.location ?? '';

    const client = createHttpClient(input);
    client.setHeaders(TECHCAREERS_HEADERS);

    this.logger.log(
      `Searching TechCareers for "${searchTerm}" in "${location}" (resultsWanted=${resultsWanted})`,
    );

    try {
      const jobs: JobPostDto[] = [];
      let page = 1;

      while (jobs.length < resultsWanted) {
        const params: Record<string, string | number> = {
          q: searchTerm,
          p: page,
        };

        if (location) {
          params.l = location;
        }

        const response = await client.get(TECHCAREERS_SEARCH_URL, { params });
        const html = response.data;

        if (!html || typeof html !== 'string') {
          this.logger.warn('Empty or invalid response from TechCareers');
          break;
        }

        const items = this.parseJobListings(html);

        if (items.length === 0) {
          this.logger.log(`No more results from TechCareers at page ${page}`);
          break;
        }

        for (const item of items) {
          if (jobs.length >= resultsWanted) break;

          try {
            const job = this.mapJob(item, input.descriptionFormat);
            if (job) jobs.push(job);
          } catch (err: any) {
            this.logger.warn(
              `Error mapping TechCareers job ${item.url}: ${err.message}`,
            );
          }
        }

        page++;
        // Safety: don't paginate more than 10 pages
        if (page > 10) break;
      }

      this.logger.log(`TechCareers returned ${jobs.length} jobs`);
      return new JobResponseDto(jobs);
    } catch (err: any) {
      this.logger.error(`TechCareers scrape error: ${err.message}`);
      return new JobResponseDto([], classifyScrapeError(err));
    }
  }

  /**
   * Parse HTML response from TechCareers to extract job listings.
   * TechCareers uses standard HTML job cards with structured content.
   */
  private parseJobListings(html: string): TechcareersJob[] {
    const jobs: TechcareersJob[] = [];

    // Match job card blocks — TechCareers uses article or div.job-listing patterns
    const jobBlocks = html.split(/<(?:article|div)\s+[^>]*class="[^"]*job[^"]*"[^>]*>/i).slice(1);

    for (const block of jobBlocks) {
      const blockContent = block.split(/<\/(?:article|div)>/i)[0] ?? block;

      const title = this.extractTextByClass(blockContent, 'job-title') ??
                     this.extractLink(blockContent);
      const url = this.extractHref(blockContent);
      const company = this.extractTextByClass(blockContent, 'company') ??
                       this.extractTextByClass(blockContent, 'employer');
      const location = this.extractTextByClass(blockContent, 'location') ??
                        this.extractTextByClass(blockContent, 'job-location');
      const datePosted = this.extractTextByClass(blockContent, 'date') ??
                          this.extractTextByClass(blockContent, 'posted-date');
      const description = this.extractTextByClass(blockContent, 'description') ??
                           this.extractTextByClass(blockContent, 'snippet');

      if (title) {
        jobs.push({
          title,
          url: url ? (url.startsWith('http') ? url : `https://www.techcareers.com${url}`) : null,
          company,
          location,
          datePosted,
          description,
        });
      }
    }

    return jobs;
  }

  /**
   * Extract text content from an HTML element by class name.
   */
  private extractTextByClass(html: string, className: string): string | null {
    const regex = new RegExp(
      `<[^>]+class="[^"]*\\b${className}\\b[^"]*"[^>]*>([\\s\\S]*?)<\\/[^>]+>`,
      'i',
    );
    const match = regex.exec(html);
    if (!match) return null;
    // Strip inner HTML tags
    return match[1].replace(/<[^>]+>/g, '').trim() || null;
  }

  /**
   * Extract the first link text from HTML.
   */
  private extractLink(html: string): string | null {
    const match = /<a[^>]*>([^<]+)<\/a>/i.exec(html);
    return match ? match[1].trim() : null;
  }

  /**
   * Extract the first href attribute from an anchor tag.
   */
  private extractHref(html: string): string | null {
    const match = /<a[^>]+href="([^"]+)"[^>]*>/i.exec(html);
    return match ? match[1] : null;
  }

  /**
   * Map a parsed TechCareers job to a JobPostDto.
   */
  private mapJob(
    item: TechcareersJob,
    descriptionFormat?: DescriptionFormat,
  ): JobPostDto | null {
    if (!item.title) return null;

    // Process description
    let description: string | null = item.description ?? null;
    if (description) {
      if (descriptionFormat === DescriptionFormat.PLAIN) {
        description = htmlToPlainText(description);
      } else if (descriptionFormat === DescriptionFormat.MARKDOWN) {
        description = markdownConverter(description) ?? description;
      }
    }

    // Parse date
    let datePosted: string | null = null;
    if (item.datePosted) {
      try {
        datePosted = toDateOnly(item.datePosted);
      } catch {
        datePosted = null;
      }
    }

    // Generate ID from URL
    const jobId = item.url ? this.extractIdFromUrl(item.url) : this.hashString(item.title);

    return new JobPostDto({
      id: `techcareers-${jobId}`,
      title: item.title,
      jobUrl: item.url ?? `https://www.techcareers.com/jobs?q=${encodeURIComponent(item.title)}`,
      companyName: item.company ?? null,
      location: item.location ? new LocationDto({ city: item.location }) : null,
      description,
      compensation: null,
      datePosted,
      isRemote: false,
      emails: extractEmails(description ?? null),
      site: Site.TECHCAREERS,
    });
  }

  /**
   * Extract short ID from a URL path.
   */
  private extractIdFromUrl(url: string): string {
    try {
      const parsed = new URL(url);
      const segments = parsed.pathname.split('/').filter(Boolean);
      return segments[segments.length - 1] ?? this.hashString(url);
    } catch {
      return this.hashString(url);
    }
  }

  /**
   * Simple string hash for fallback IDs.
   */
  private hashString(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash + char) | 0;
    }
    return Math.abs(hash).toString(36);
  }
}
