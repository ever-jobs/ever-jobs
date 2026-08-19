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
import { ECOJOBS_RSS_URL, ECOJOBS_HEADERS } from './ecojobs.constants';
import { EcojobsRssItem } from './ecojobs.types';

@SourcePlugin({
  site: Site.ECOJOBS,
  name: 'EcoJobs',
  category: 'niche',
})
@Injectable()
export class EcojobsService implements IScraper {
  private readonly logger = new Logger(EcojobsService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const resultsWanted = input.resultsWanted ?? 25;

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(ECOJOBS_HEADERS);

    this.logger.log(
      `Fetching EcoJobs RSS feed (resultsWanted=${resultsWanted})`,
    );

    try {
      const response = await client.get(ECOJOBS_RSS_URL);
      const xml = response.data;

      if (!xml || typeof xml !== 'string') {
        this.logger.warn('Empty or invalid RSS response from EcoJobs');
        return new JobResponseDto([]);
      }

      const items = this.parseRssItems(xml);
      this.logger.log(`Parsed ${items.length} items from EcoJobs RSS feed`);

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
            `Error mapping EcoJobs job ${item.link}: ${err.message}`,
          );
        }
      }

      this.logger.log(`EcoJobs returned ${jobs.length} jobs`);
      return new JobResponseDto(jobs);
    } catch (err: any) {
      this.logger.error(`EcoJobs scrape error: ${err.message}`);
      return new JobResponseDto([], classifyScrapeError(err));
    }
  }

  /**
   * Parse RSS XML into an array of EcojobsRssItem using regex.
   */
  private parseRssItems(xml: string): EcojobsRssItem[] {
    const items: EcojobsRssItem[] = [];

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
  private matchesSearch(item: EcojobsRssItem, searchTerm: string): boolean {
    const term = searchTerm.toLowerCase();
    const title = (item.title ?? '').toLowerCase();
    const description = (item.description ?? '').toLowerCase();

    return title.includes(term) || description.includes(term);
  }

  /**
   * Map a parsed RSS item to a JobPostDto.
   * EcoJobs titles are plain job titles (no company prefix).
   */
  private mapJob(
    item: EcojobsRssItem,
    descriptionFormat?: DescriptionFormat,
  ): JobPostDto | null {
    if (!item.title || !item.link) return null;

    const jobTitle = item.title;

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
    if (item.pubDate) {
      try {
        datePosted = toDateOnly(item.pubDate);
      } catch {
        datePosted = null;
      }
    }

    // Extract job ID from URL
    const jobId = this.extractIdFromUrl(item.guid ?? item.link);

    return new JobPostDto({
      id: `ecojobs-${jobId}`,
      title: jobTitle,
      jobUrl: item.link,
      companyName: null,
      description,
      compensation: null,
      datePosted,
      jobType: null,
      isRemote: false,
      emails: extractEmails(description ?? null),
      site: Site.ECOJOBS,
    });
  }

  /**
   * Extract a short ID from a URL.
   * EcoJobs URLs: /job/counsel-bi-lingual/
   */
  private extractIdFromUrl(url: string): string {
    // EcoJobs URLs: /job/counsel-bi-lingual/
    const match = /\/job\/([^/]+)\/?/.exec(url);
    if (match) return match[1];

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
