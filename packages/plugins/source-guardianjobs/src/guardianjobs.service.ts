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
  Country,
} from '@ever-jobs/models';
import {
  createHttpClient,
  htmlToPlainText,
  markdownConverter,
  extractEmails,
  toDateOnly,
} from '@ever-jobs/common';
import { GUARDIANJOBS_RSS_URL, GUARDIANJOBS_HEADERS } from './guardianjobs.constants';
import { GuardianjobsRssItem } from './guardianjobs.types';

@SourcePlugin({
  site: Site.GUARDIANJOBS,
  name: 'GuardianJobs',
  category: 'regional',
})
@Injectable()
export class GuardianjobsService implements IScraper {
  private readonly logger = new Logger(GuardianjobsService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const resultsWanted = input.resultsWanted ?? 25;

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(GUARDIANJOBS_HEADERS);

    this.logger.log(
      `Fetching Guardian Jobs RSS feed (resultsWanted=${resultsWanted})`,
    );

    try {
      const response = await client.get(GUARDIANJOBS_RSS_URL);
      const xml = response.data;

      if (!xml || typeof xml !== 'string') {
        this.logger.warn('Empty or invalid RSS response from Guardian Jobs');
        return new JobResponseDto([]);
      }

      const items = this.parseRssItems(xml);
      this.logger.log(`Parsed ${items.length} items from Guardian Jobs RSS feed`);

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
            `Error mapping Guardian Jobs job ${item.link}: ${err.message}`,
          );
        }
      }

      this.logger.log(`Guardian Jobs returned ${jobs.length} jobs`);
      return new JobResponseDto(jobs);
    } catch (err: any) {
      this.logger.error(`Guardian Jobs scrape error: ${err.message}`);
      return new JobResponseDto([]);
    }
  }

  /**
   * Parse RSS XML into an array of GuardianjobsRssItem using regex.
   */
  private parseRssItems(xml: string): GuardianjobsRssItem[] {
    const items: GuardianjobsRssItem[] = [];

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
  private matchesSearch(item: GuardianjobsRssItem, searchTerm: string): boolean {
    const term = searchTerm.toLowerCase();
    const title = (item.title ?? '').toLowerCase();
    const description = (item.description ?? '').toLowerCase();

    return title.includes(term) || description.includes(term);
  }

  /**
   * Map a parsed RSS item to a JobPostDto.
   * Guardian Jobs title format: "COMPANY: Job Title"
   */
  private mapJob(
    item: GuardianjobsRssItem,
    descriptionFormat?: DescriptionFormat,
  ): JobPostDto | null {
    if (!item.title || !item.link) return null;

    // Parse company from title (format: "COMPANY: Job Title")
    let companyName: string | null = null;
    let jobTitle = item.title;
    const colonIdx = item.title.indexOf(': ');
    if (colonIdx > 0) {
      companyName = item.title.substring(0, colonIdx).trim();
      jobTitle = item.title.substring(colonIdx + 2).trim();
    }

    // Process description (Guardian Jobs returns plain text with newlines)
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
      id: `guardianjobs-${jobId}`,
      title: jobTitle,
      jobUrl: item.link,
      companyName,
      location: new LocationDto({ country: Country.UK }),
      description,
      compensation: null,
      datePosted,
      jobType: null,
      isRemote: false,
      emails: extractEmails(description ?? null),
      site: Site.GUARDIANJOBS,
    });
  }

  /**
   * Extract a short ID from a URL.
   */
  private extractIdFromUrl(url: string): string {
    // Guardian Jobs URLs: /job/10037831/programme-manager-nature-awards/
    const match = /\/job\/(\d+)\//.exec(url);
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
