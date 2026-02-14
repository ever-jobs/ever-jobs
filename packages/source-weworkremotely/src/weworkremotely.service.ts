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
import { WWR_RSS_URL, WWR_HEADERS } from './weworkremotely.constants';
import { WwrRssItem } from './weworkremotely.types';

@Injectable()
export class WeWorkRemotelyService implements IScraper {
  private readonly logger = new Logger(WeWorkRemotelyService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const resultsWanted = input.resultsWanted ?? 25;

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(WWR_HEADERS);

    this.logger.log(
      `Fetching We Work Remotely RSS feed (resultsWanted=${resultsWanted})`,
    );

    try {
      const response = await client.get<string>(WWR_RSS_URL);
      const xml = response.data;

      if (!xml || typeof xml !== 'string') {
        this.logger.warn('Empty or invalid RSS response from We Work Remotely');
        return new JobResponseDto([]);
      }

      const items = this.parseRssItems(xml);
      this.logger.log(`Parsed ${items.length} items from WWR RSS feed`);

      const jobs: JobPostDto[] = [];

      for (const item of items) {
        if (jobs.length >= resultsWanted) break;

        try {
          // Filter by search term if provided
          if (input.searchTerm && !this.matchesSearch(item, input.searchTerm)) {
            continue;
          }

          const job = this.mapJob(item, input.descriptionFormat);
          if (job) jobs.push(job);
        } catch (err: any) {
          this.logger.warn(
            `Error mapping WWR job ${item.link}: ${err.message}`,
          );
        }
      }

      this.logger.log(`We Work Remotely returned ${jobs.length} jobs`);
      return new JobResponseDto(jobs);
    } catch (err: any) {
      this.logger.error(`We Work Remotely scrape error: ${err.message}`);
      return new JobResponseDto([]);
    }
  }

  /**
   * Parse RSS XML into an array of WwrRssItem using regex (no XML library).
   */
  private parseRssItems(xml: string): WwrRssItem[] {
    const items: WwrRssItem[] = [];

    // Split by <item> tags to get individual entries
    const itemBlocks = xml.split(/<item>/i).slice(1);

    for (const block of itemBlocks) {
      // Trim at </item> to avoid leaking into the next item
      const itemContent = block.split(/<\/item>/i)[0] ?? block;

      items.push({
        title: this.extractTag(itemContent, 'title'),
        link: this.extractTag(itemContent, 'link'),
        guid: this.extractTag(itemContent, 'guid'),
        description: this.extractTag(itemContent, 'description'),
        pubDate: this.extractTag(itemContent, 'pubDate'),
        region: this.extractTag(itemContent, 'region'),
        country: this.extractTag(itemContent, 'country'),
        state: this.extractTag(itemContent, 'state'),
        skills: this.extractTag(itemContent, 'skills'),
        category: this.extractTag(itemContent, 'category'),
        type: this.extractTag(itemContent, 'type'),
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
  private matchesSearch(item: WwrRssItem, searchTerm: string): boolean {
    const term = searchTerm.toLowerCase();
    const title = (item.title ?? '').toLowerCase();
    const skills = (item.skills ?? '').toLowerCase();

    return title.includes(term) || skills.includes(term);
  }

  /**
   * Map a parsed RSS item to a JobPostDto.
   */
  private mapJob(
    item: WwrRssItem,
    descriptionFormat?: DescriptionFormat,
  ): JobPostDto | null {
    if (!item.title || !item.link) return null;

    // Parse title format "Company: Job Title"
    let companyName: string | null = null;
    let jobTitle = item.title;

    const separatorIndex = item.title.indexOf(': ');
    if (separatorIndex > 0) {
      companyName = item.title.substring(0, separatorIndex).trim();
      jobTitle = item.title.substring(separatorIndex + 2).trim();
    }

    // Process description (WeWorkRemotely RSS returns HTML)
    let description: string | null = item.description ?? null;
    if (description) {
      if (descriptionFormat === DescriptionFormat.PLAIN) {
        description = htmlToPlainText(description);
      } else if (descriptionFormat === DescriptionFormat.MARKDOWN) {
        description = markdownConverter(description) ?? description;
      }
    }

    // Build location
    const location = new LocationDto({
      city: item.region ?? null,
      country: item.country ?? null,
      state: item.state ?? null,
    });

    // Parse date from RFC 2822 format
    let datePosted: string | null = null;
    if (item.pubDate) {
      try {
        datePosted = new Date(item.pubDate).toISOString().split('T')[0];
      } catch {
        datePosted = null;
      }
    }

    // Generate ID from the last path segment of the URL
    const jobId = this.extractIdFromUrl(item.guid ?? item.link);

    return new JobPostDto({
      id: `wwr-${jobId}`,
      title: jobTitle,
      companyName,
      jobUrl: item.link,
      location,
      description,
      compensation: null,
      datePosted,
      jobType: item.type ? [getJobTypeFromString(item.type)].filter((t): t is JobType => t !== null) : null,
      isRemote: true,
      emails: extractEmails(description),
      site: Site.WEWORKREMOTELY,
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
