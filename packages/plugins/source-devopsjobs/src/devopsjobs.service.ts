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
import { DEVOPSJOBS_RSS_URL, DEVOPSJOBS_HEADERS } from './devopsjobs.constants';
import { DevopsjobsRssItem } from './devopsjobs.types';

@SourcePlugin({
  site: Site.DEVOPSJOBS,
  name: 'DevOpsJobs',
  category: 'niche',
})
@Injectable()
export class DevopsjobsService implements IScraper {
  private readonly logger = new Logger(DevopsjobsService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const resultsWanted = input.resultsWanted ?? 25;

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(DEVOPSJOBS_HEADERS);

    this.logger.log(
      `Fetching DevOpsJobs RSS feed (resultsWanted=${resultsWanted})`,
    );

    try {
      const response = await client.get(DEVOPSJOBS_RSS_URL);
      const xml = response.data;

      if (!xml || typeof xml !== 'string') {
        this.logger.warn('Empty or invalid RSS response from DevOpsJobs');
        return new JobResponseDto([]);
      }

      const items = this.parseRssItems(xml);
      this.logger.log(`Parsed ${items.length} items from DevOpsJobs RSS feed`);

      const jobs: JobPostDto[] = [];

      for (const item of items) {
        if (jobs.length >= resultsWanted) break;

        try {
          if (input.searchTerm && !this.matchesSearch(item, input.searchTerm)) {
            continue;
          }

          const job = this.mapJob(item, input.descriptionFormat);
          if (job) jobs.push(job);
        } catch (err: any) {
          this.logger.warn(
            `Error mapping DevOpsJobs job ${item.link}: ${err.message}`,
          );
        }
      }

      this.logger.log(`DevOpsJobs returned ${jobs.length} jobs`);
      return new JobResponseDto(jobs);
    } catch (err: any) {
      this.logger.error(`DevOpsJobs scrape error: ${err.message}`);
      return new JobResponseDto([]);
    }
  }

  /**
   * Parse RSS XML into an array of DevopsjobsRssItem using regex.
   */
  private parseRssItems(xml: string): DevopsjobsRssItem[] {
    const items: DevopsjobsRssItem[] = [];

    const itemBlocks = xml.split(/<item>/i).slice(1);

    for (const block of itemBlocks) {
      const itemContent = block.split(/<\/item>/i)[0] ?? block;

      items.push({
        title: this.extractTag(itemContent, 'title'),
        link: this.extractTag(itemContent, 'link'),
        guid: this.extractTag(itemContent, 'guid'),
        description: this.extractTag(itemContent, 'description'),
        pubDate: this.extractTag(itemContent, 'pubDate'),
      });
    }

    return items;
  }

  /**
   * Extract the text content of an XML tag using regex.
   * Handles both CDATA-wrapped and plain content.
   */
  private extractTag(xml: string, tagName: string): string | null {
    const cdataRegex = new RegExp(
      `<${tagName}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*<\\/${tagName}>`,
      'i',
    );
    const cdataMatch = cdataRegex.exec(xml);
    if (cdataMatch) return cdataMatch[1].trim();

    const plainRegex = new RegExp(
      `<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`,
      'i',
    );
    const plainMatch = plainRegex.exec(xml);
    if (plainMatch) return plainMatch[1].trim();

    return null;
  }

  /**
   * Check whether an RSS item matches the given search term.
   */
  private matchesSearch(item: DevopsjobsRssItem, searchTerm: string): boolean {
    const term = searchTerm.toLowerCase();
    const title = (item.title ?? '').toLowerCase();
    const description = (item.description ?? '').toLowerCase();

    return title.includes(term) || description.includes(term);
  }

  /**
   * Map a parsed RSS item to a JobPostDto.
   * DevOpsJobs title format: "Title - Company - Location"
   */
  private mapJob(
    item: DevopsjobsRssItem,
    descriptionFormat?: DescriptionFormat,
  ): JobPostDto | null {
    if (!item.title || !item.link) return null;

    // Parse title: "Title - Company - Location"
    const parts = item.title.split(' - ').map((p) => p.trim());
    const jobTitle = parts[0] ?? item.title;
    const companyName = parts.length > 1 ? parts[1] : null;
    const locationCity = parts.length > 2 ? parts[2] : null;

    // Process description (DevOpsJobs returns HTML in CDATA)
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
    if (item.pubDate) {
      try {
        datePosted = toDateOnly(item.pubDate);
      } catch {
        datePosted = null;
      }
    }

    // Extract job ID from URL slug
    const jobId = this.extractIdFromUrl(item.guid ?? item.link);

    // Build location
    const location = new LocationDto({
      city: locationCity ?? null,
    });

    return new JobPostDto({
      id: `devopsjobs-${jobId}`,
      title: jobTitle,
      jobUrl: item.link,
      companyName,
      location,
      description,
      compensation: null,
      datePosted,
      jobType: null,
      isRemote: false,
      emails: extractEmails(description ?? null),
      site: Site.DEVOPSJOBS,
    });
  }

  /**
   * Extract a short ID from a URL by using the last path segment.
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
