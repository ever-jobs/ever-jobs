import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
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
import { GREENJOBSBOARD_RSS_URL, GREENJOBSBOARD_HEADERS } from './greenjobsboard.constants';
import { GreenJobsBoardRssItem } from './greenjobsboard.types';

@SourcePlugin({
  site: Site.GREENJOBSBOARD,
  name: 'GreenJobsBoard',
  category: 'niche',
})
@Injectable()
export class GreenJobsBoardService implements IScraper {
  private readonly logger = new Logger(GreenJobsBoardService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const resultsWanted = input.resultsWanted ?? 25;

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(GREENJOBSBOARD_HEADERS);

    this.logger.log(
      `Fetching Green Jobs Board RSS feed (resultsWanted=${resultsWanted})`,
    );

    try {
      const response = await client.get(GREENJOBSBOARD_RSS_URL);
      const xml = response.data;

      if (!xml || typeof xml !== 'string') {
        this.logger.warn('Empty or invalid RSS response from Green Jobs Board');
        return new JobResponseDto([]);
      }

      const items = this.parseRssItems(xml);
      this.logger.log(`Parsed ${items.length} items from Green Jobs Board RSS feed`);

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
            `Error mapping Green Jobs Board job ${item.link}: ${err.message}`,
          );
        }
      }

      this.logger.log(`Green Jobs Board returned ${jobs.length} jobs`);
      return new JobResponseDto(jobs);
    } catch (err: any) {
      this.logger.error(`Green Jobs Board scrape error: ${err.message}`);
      return new JobResponseDto([]);
    }
  }

  /**
   * Parse RSS XML into an array of GreenJobsBoardRssItem using regex (no XML library).
   */
  private parseRssItems(xml: string): GreenJobsBoardRssItem[] {
    const items: GreenJobsBoardRssItem[] = [];

    const itemBlocks = xml.split(/<item>/i).slice(1);

    for (const block of itemBlocks) {
      const itemContent = block.split(/<\/item>/i)[0] ?? block;

      items.push({
        title: this.extractTag(itemContent, 'title'),
        link: this.extractTag(itemContent, 'link'),
        guid: this.extractTag(itemContent, 'guid'),
        description: this.extractTag(itemContent, 'description'),
        pubDate: this.extractTag(itemContent, 'pubDate'),
        creator: this.extractTag(itemContent, 'dc:creator'),
        contentEncoded: this.extractTag(itemContent, 'content:encoded'),
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
  private matchesSearch(item: GreenJobsBoardRssItem, searchTerm: string): boolean {
    const term = searchTerm.toLowerCase();
    const title = (item.title ?? '').toLowerCase();
    const description = (item.description ?? '').toLowerCase();
    const creator = (item.creator ?? '').toLowerCase();

    return title.includes(term) || description.includes(term) || creator.includes(term);
  }

  /**
   * Map a parsed RSS item to a JobPostDto.
   */
  private mapJob(
    item: GreenJobsBoardRssItem,
    descriptionFormat?: DescriptionFormat,
  ): JobPostDto | null {
    if (!item.title || !item.link) return null;

    // Use content:encoded for full description if available, fallback to description
    const rawDescription = item.contentEncoded ?? item.description ?? undefined;

    // Process description (Green Jobs Board RSS may return HTML)
    let description: string | undefined = rawDescription;
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
      id: `greenjobsboard-${jobId}`,
      title: item.title,
      jobUrl: item.link,
      companyName: item.creator ?? undefined,
      description,
      compensation: undefined,
      datePosted,
      isRemote: false,
      emails: extractEmails(description ?? null),
      site: Site.GREENJOBSBOARD,
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
