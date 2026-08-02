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
  JobType,
  getJobTypeFromString,
} from '@ever-jobs/models';
import {
  createHttpClient,
  htmlToPlainText,
  markdownConverter,
  extractEmails,
  toDateOnly,
} from '@ever-jobs/common';
import { JOBSINJAPAN_RSS_URL, JOBSINJAPAN_HEADERS } from './jobsinjapan.constants';
import { JobsInJapanRssItem } from './jobsinjapan.types';

@SourcePlugin({
  site: Site.JOBSINJAPAN,
  name: 'JobsInJapan',
  category: 'regional',
})
@Injectable()
export class JobsInJapanService implements IScraper {
  private readonly logger = new Logger(JobsInJapanService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const resultsWanted = input.resultsWanted ?? 25;

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(JOBSINJAPAN_HEADERS);

    this.logger.log(
      `Fetching Jobs in Japan RSS feed (resultsWanted=${resultsWanted})`,
    );

    try {
      const response = await client.get(JOBSINJAPAN_RSS_URL);
      const xml = response.data;

      if (!xml || typeof xml !== 'string') {
        this.logger.warn('Empty or invalid RSS response from Jobs in Japan');
        return new JobResponseDto([]);
      }

      const items = this.parseRssItems(xml);
      this.logger.log(`Parsed ${items.length} items from Jobs in Japan RSS feed`);

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
            `Error mapping Jobs in Japan job ${item.link}: ${err.message}`,
          );
        }
      }

      this.logger.log(`Jobs in Japan returned ${jobs.length} jobs`);
      return new JobResponseDto(jobs);
    } catch (err: any) {
      this.logger.error(`Jobs in Japan scrape error: ${err.message}`);
      return new JobResponseDto([]);
    }
  }

  /**
   * Parse RSS XML into an array of JobsInJapanRssItem using regex (no XML library).
   */
  private parseRssItems(xml: string): JobsInJapanRssItem[] {
    const items: JobsInJapanRssItem[] = [];

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
        company: this.extractTag(itemContent, 'company'),
        jobType: this.extractTag(itemContent, 'job_type'),
        jobAddress: this.extractTag(itemContent, 'job_address'),
        salary: this.extractTag(itemContent, '_salary'),
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
  private matchesSearch(item: JobsInJapanRssItem, searchTerm: string): boolean {
    const term = searchTerm.toLowerCase();
    const title = (item.title ?? '').toLowerCase();
    const description = (item.description ?? '').toLowerCase();
    const company = (item.company ?? item.creator ?? '').toLowerCase();
    const jobAddress = (item.jobAddress ?? '').toLowerCase();

    return (
      title.includes(term) ||
      description.includes(term) ||
      company.includes(term) ||
      jobAddress.includes(term)
    );
  }

  /**
   * Map a parsed RSS item to a JobPostDto.
   */
  private mapJob(
    item: JobsInJapanRssItem,
    descriptionFormat?: DescriptionFormat,
  ): JobPostDto | null {
    if (!item.title || !item.link) return null;

    // Use content:encoded for full description if available, fallback to description
    const rawDescription = item.contentEncoded ?? item.description ?? undefined;

    // Process description (WordPress RSS returns HTML)
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

    // Resolve company name: prefer custom company field, fallback to dc:creator
    const companyName = item.company ?? item.creator ?? undefined;

    // Resolve job type from custom field
    const jobType = this.resolveJobType(item.jobType);

    // Build location from jobAddress field
    const location = new LocationDto({
      city: item.jobAddress ?? undefined,
      country: 'Japan',
    });

    return new JobPostDto({
      id: `jobsinjapan-${jobId}`,
      title: item.title,
      jobUrl: item.link,
      companyName,
      description,
      compensation: undefined,
      datePosted,
      jobType,
      location,
      isRemote: false,
      emails: extractEmails(description ?? null),
      site: Site.JOBSINJAPAN,
    });
  }

  /**
   * Resolve a raw job type string to a JobType[] array.
   */
  private resolveJobType(raw: string | null): JobType[] | null {
    if (!raw) return null;

    const resolved = getJobTypeFromString(raw);
    return resolved ? [resolved] : null;
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
