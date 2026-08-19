import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper,
  ScraperInputDto,
  JobResponseDto,
  JobPostDto,
  LocationDto,
  DescriptionFormat,
  Site,
} from '@ever-jobs/models';
import {
  createHttpClient,
  htmlToPlainText,
  markdownConverter,
  extractEmails,
  toDateOnly,
} from '@ever-jobs/common';
import { HASJOB_FEED_URL, HASJOB_DEFAULT_RESULTS, HASJOB_HEADERS } from './hasjob.constants';
import { HasJobAtomEntry } from './hasjob.types';

@SourcePlugin({
  site: Site.HASJOB,
  name: 'HasJob',
  category: 'regional',
})
@Injectable()
export class HasJobService implements IScraper {
  private readonly logger = new Logger(HasJobService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const resultsWanted = input.resultsWanted ?? HASJOB_DEFAULT_RESULTS;

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(HASJOB_HEADERS);

    this.logger.log(`Fetching HasJob Atom feed: ${HASJOB_FEED_URL}`);

    try {
      const response = await client.get(HASJOB_FEED_URL);
      const xml = response.data;

      if (!xml || typeof xml !== 'string') {
        this.logger.warn('Empty or invalid Atom response from HasJob');
        return new JobResponseDto([]);
      }

      const entries = this.parseAtomEntries(xml);
      this.logger.log(`Parsed ${entries.length} entries from HasJob Atom feed`);

      const jobs: JobPostDto[] = [];

      for (const entry of entries) {
        if (jobs.length >= resultsWanted) break;

        try {
          if (input.searchTerm && !this.matchesSearch(entry, input.searchTerm)) {
            continue;
          }

          const job = this.mapJob(entry, input.descriptionFormat);
          if (job) jobs.push(job);
        } catch (err: any) {
          this.logger.warn(
            `Error mapping HasJob entry ${entry.link}: ${err.message}`,
          );
        }
      }

      this.logger.log(`HasJob returned ${jobs.length} jobs`);
      return new JobResponseDto(jobs);
    } catch (err: any) {
      this.logger.error(`HasJob scrape error: ${err.message}`);
      return new JobResponseDto([], classifyScrapeError(err));
    }
  }

  /**
   * Parse Atom XML into an array of HasJobAtomEntry using regex (no XML library).
   * Atom feeds use <entry> instead of <item> and <content> instead of <description>.
   */
  private parseAtomEntries(xml: string): HasJobAtomEntry[] {
    const entries: HasJobAtomEntry[] = [];

    const entryBlocks = xml.split(/<entry>/i).slice(1);

    for (const block of entryBlocks) {
      const content = block.split(/<\/entry>/i)[0] ?? block;

      entries.push({
        title: this.extractTag(content, 'title'),
        link: this.extractAtomLink(content),
        content: this.extractTag(content, 'content'),
        published: this.extractTag(content, 'published'),
        updated: this.extractTag(content, 'updated'),
        location: this.extractTag(content, 'location'),
      });
    }

    return entries;
  }

  /**
   * Extract the link from Atom's self-closing <link href="..." /> tags.
   * Atom uses <link href="URL" rel="alternate" /> rather than <link>URL</link>.
   */
  private extractAtomLink(xml: string): string | null {
    // Atom links: <link href="URL" rel="alternate" />
    const linkRegex = /<link[^>]+href="([^"]+)"[^>]*rel="alternate"[^>]*\/?>/i;
    const match = linkRegex.exec(xml);
    if (match) return match[1].trim();

    // Fallback: any link href
    const fallbackRegex = /<link[^>]+href="([^"]+)"[^>]*\/?>/i;
    const fallback = fallbackRegex.exec(xml);
    if (fallback) return fallback[1].trim();

    return null;
  }

  /**
   * Extract the text content of an XML tag using regex.
   * Handles both CDATA-wrapped and plain content.
   */
  private extractTag(xml: string, tagName: string): string | null {
    const escaped = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // Try CDATA first: <tag><![CDATA[content]]></tag>
    const cdataRegex = new RegExp(
      `<${escaped}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*<\\/${escaped}>`,
      'i',
    );
    const cdataMatch = cdataRegex.exec(xml);
    if (cdataMatch) return cdataMatch[1].trim();

    // Try plain content: <tag>content</tag>
    const plainRegex = new RegExp(
      `<${escaped}[^>]*>([\\s\\S]*?)<\\/${escaped}>`,
      'i',
    );
    const plainMatch = plainRegex.exec(xml);
    if (plainMatch) return plainMatch[1].trim();

    return null;
  }

  /**
   * Check whether an Atom entry matches the given search term.
   */
  private matchesSearch(entry: HasJobAtomEntry, searchTerm: string): boolean {
    const term = searchTerm.toLowerCase();
    const title = (entry.title ?? '').toLowerCase();
    const content = (entry.content ?? '').toLowerCase();
    const location = (entry.location ?? '').toLowerCase();

    return title.includes(term) || content.includes(term) || location.includes(term);
  }

  /**
   * Map a parsed Atom entry to a JobPostDto.
   */
  private mapJob(
    entry: HasJobAtomEntry,
    descriptionFormat?: DescriptionFormat,
  ): JobPostDto | null {
    if (!entry.title || !entry.link) return null;

    // Process description from Atom <content>
    let description: string | undefined = entry.content ?? undefined;
    if (description) {
      if (descriptionFormat === DescriptionFormat.PLAIN) {
        description = htmlToPlainText(description);
      } else if (descriptionFormat === DescriptionFormat.MARKDOWN) {
        description = markdownConverter(description) ?? description;
      }
    }

    // Build location -- default to India region for HasJob (India/South Asia focus)
    const location = new LocationDto({
      city: entry.location ?? null,
      country: 'India',
    });

    // Parse date from Atom <published>
    let datePosted: string | undefined;
    if (entry.published) {
      try {
        datePosted = toDateOnly(entry.published) ?? undefined;
      } catch {
        datePosted = undefined;
      }
    }

    // Generate ID from URL
    const jobId = this.extractIdFromUrl(entry.link);

    return new JobPostDto({
      id: `hasjob-${jobId}`,
      title: entry.title,
      jobUrl: entry.link,
      location,
      description,
      compensation: undefined,
      datePosted,
      isRemote: false,
      emails: extractEmails(description ?? null),
      site: Site.HASJOB,
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
