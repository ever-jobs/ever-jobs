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
} from '@ever-jobs/models';
import {
  createHttpClient,
  htmlToPlainText,
  markdownConverter,
  extractEmails,
  toDateOnly,
} from '@ever-jobs/common';
import { FOSSJOBS_RSS_URL, FOSSJOBS_HEADERS } from './fossjobs.constants';
import { FossJobsRssItem } from './fossjobs.types';

@SourcePlugin({
  site: Site.FOSSJOBS,
  name: 'FOSSJobs',
  category: 'niche',
})
@Injectable()
export class FossJobsService implements IScraper {
  private readonly logger = new Logger(FossJobsService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const resultsWanted = input.resultsWanted ?? 25;

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(FOSSJOBS_HEADERS);

    this.logger.log(
      `Fetching FossJobs RSS feed (resultsWanted=${resultsWanted})`,
    );

    try {
      const response = await client.get(FOSSJOBS_RSS_URL);
      const xml = response.data;

      if (!xml || typeof xml !== 'string') {
        this.logger.warn('Empty or invalid RSS response from FossJobs');
        return new JobResponseDto([]);
      }

      const items = this.parseRssItems(xml);
      this.logger.log(`Parsed ${items.length} items from FossJobs RSS feed`);

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
            `Error mapping FossJobs job ${item.link}: ${err.message}`,
          );
        }
      }

      this.logger.log(`FossJobs returned ${jobs.length} jobs`);
      return new JobResponseDto(jobs);
    } catch (err: any) {
      this.logger.error(`FossJobs scrape error: ${err.message}`);
      return new JobResponseDto([], classifyScrapeError(err));
    }
  }

  /**
   * Parse RSS XML into an array of FossJobsRssItem using regex (no XML library).
   */
  private parseRssItems(xml: string): FossJobsRssItem[] {
    const items: FossJobsRssItem[] = [];

    const itemBlocks = xml.split(/<item>/i).slice(1);

    for (const block of itemBlocks) {
      const itemContent = block.split(/<\/item>/i)[0] ?? block;

      items.push({
        title: this.extractTag(itemContent, 'title'),
        link: this.extractTag(itemContent, 'link'),
        guid: this.extractTag(itemContent, 'guid'),
        description: this.extractTag(itemContent, 'description'),
        pubDate: this.extractTag(itemContent, 'pubDate'),
        category: this.extractTag(itemContent, 'category'),
      });
    }

    return items;
  }

  /**
   * Extract the text content of an XML tag using regex.
   * Handles both CDATA-wrapped and plain content.
   */
  private extractTag(xml: string, tagName: string): string | null {
    // Try CDATA first: <tag><![CDATA[content]]></tag>
    const cdataRegex = new RegExp(
      `<${tagName}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*<\\/${tagName}>`,
      'i',
    );
    const cdataMatch = cdataRegex.exec(xml);
    if (cdataMatch) return cdataMatch[1].trim();

    // Try plain content: <tag>content</tag>
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
  private matchesSearch(item: FossJobsRssItem, searchTerm: string): boolean {
    const term = searchTerm.toLowerCase();
    const title = (item.title ?? '').toLowerCase();
    const description = (item.description ?? '').toLowerCase();
    const category = (item.category ?? '').toLowerCase();

    return title.includes(term) || description.includes(term) || category.includes(term);
  }

  /**
   * Map a parsed RSS item to a JobPostDto.
   */
  private mapJob(
    item: FossJobsRssItem,
    descriptionFormat?: DescriptionFormat,
  ): JobPostDto | null {
    if (!item.title || !item.link) return null;

    // Process description (FossJobs RSS may return HTML)
    let description: string | undefined = item.description ?? undefined;
    if (description) {
      if (descriptionFormat === DescriptionFormat.PLAIN) {
        description = htmlToPlainText(description);
      } else if (descriptionFormat === DescriptionFormat.MARKDOWN) {
        description = markdownConverter(description) ?? description;
      }
    }

    // Parse date
    let datePosted: string | undefined;
    if (item.pubDate) {
      try {
        datePosted = toDateOnly(item.pubDate) ?? undefined;
      } catch {
        datePosted = undefined;
      }
    }

    // Generate ID from GUID or URL
    const jobId = this.extractIdFromUrl(item.guid ?? item.link);

    return new JobPostDto({
      id: `fossjobs-${jobId}`,
      title: item.title,
      jobUrl: item.link,
      description,
      compensation: undefined,
      datePosted,
      isRemote: false,
      emails: extractEmails(description ?? null),
      site: Site.FOSSJOBS,
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
