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
import { BERLINSTARTUPJOBS_RSS_URL, BERLINSTARTUPJOBS_DEFAULT_RESULTS, BERLINSTARTUPJOBS_HEADERS } from './berlinstartupjobs.constants';
import { BerlinStartupJobsRssItem } from './berlinstartupjobs.types';

@SourcePlugin({
  site: Site.BERLINSTARTUPJOBS,
  name: 'BerlinStartupJobs',
  category: 'regional',
})
@Injectable()
export class BerlinStartupJobsService implements IScraper {
  private readonly logger = new Logger(BerlinStartupJobsService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const resultsWanted = input.resultsWanted ?? BERLINSTARTUPJOBS_DEFAULT_RESULTS;

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(BERLINSTARTUPJOBS_HEADERS);

    this.logger.log(`Fetching Berlin Startup Jobs RSS: ${BERLINSTARTUPJOBS_RSS_URL}`);

    try {
      const response = await client.get(BERLINSTARTUPJOBS_RSS_URL);
      const xml = response.data;

      if (!xml || typeof xml !== 'string') {
        this.logger.warn('Empty or invalid RSS response from Berlin Startup Jobs');
        return new JobResponseDto([]);
      }

      const items = this.parseRssItems(xml);
      this.logger.log(`Parsed ${items.length} items from Berlin Startup Jobs RSS feed`);

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
          this.logger.warn(`Error mapping Berlin Startup Jobs item ${item.link}: ${err.message}`);
        }
      }

      this.logger.log(`Berlin Startup Jobs returned ${jobs.length} jobs`);
      return new JobResponseDto(jobs);
    } catch (err: any) {
      this.logger.error(`Berlin Startup Jobs scrape error: ${err.message}`);
      return new JobResponseDto([], classifyScrapeError(err));
    }
  }

  private parseRssItems(xml: string): BerlinStartupJobsRssItem[] {
    const items: BerlinStartupJobsRssItem[] = [];
    const itemBlocks = xml.split(/<item>/i).slice(1);

    for (const block of itemBlocks) {
      const itemContent = block.split(/<\/item>/i)[0] ?? block;

      items.push({
        title: this.extractTag(itemContent, 'title'),
        link: this.extractTag(itemContent, 'link'),
        description: this.extractTag(itemContent, 'description'),
        pubDate: this.extractTag(itemContent, 'pubDate'),
        guid: this.extractTag(itemContent, 'guid'),
        creator: this.extractTag(itemContent, 'dc:creator'),
        category: this.extractTag(itemContent, 'category'),
      });
    }

    return items;
  }

  private extractTag(xml: string, tagName: string): string | null {
    const escaped = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    const cdataRegex = new RegExp(
      `<${escaped}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*<\\/${escaped}>`,
      'i',
    );
    const cdataMatch = cdataRegex.exec(xml);
    if (cdataMatch) return cdataMatch[1].trim();

    const plainRegex = new RegExp(
      `<${escaped}[^>]*>([\\s\\S]*?)<\\/${escaped}>`,
      'i',
    );
    const plainMatch = plainRegex.exec(xml);
    if (plainMatch) return plainMatch[1].trim();

    return null;
  }

  private matchesSearch(item: BerlinStartupJobsRssItem, searchTerm: string): boolean {
    const term = searchTerm.toLowerCase();
    const title = (item.title ?? '').toLowerCase();
    const description = (item.description ?? '').toLowerCase();
    const category = (item.category ?? '').toLowerCase();
    return title.includes(term) || description.includes(term) || category.includes(term);
  }

  private mapJob(item: BerlinStartupJobsRssItem, descriptionFormat?: DescriptionFormat): JobPostDto | null {
    if (!item.title || !item.link) return null;

    // Titles are "Job Title // Company" — extract company
    let companyName: string | null = null;
    const titleParts = item.title.split('//');
    if (titleParts.length > 1) {
      companyName = titleParts[titleParts.length - 1].trim();
    }

    let description: string | undefined = item.description ?? undefined;
    if (description) {
      if (descriptionFormat === DescriptionFormat.PLAIN) {
        description = htmlToPlainText(description);
      } else if (descriptionFormat === DescriptionFormat.MARKDOWN) {
        if (/<[^>]+>/.test(description)) {
          description = markdownConverter(description) ?? description;
        }
      }
    }

    let datePosted: string | undefined;
    if (item.pubDate) {
      try {
        datePosted = toDateOnly(item.pubDate) ?? undefined;
      } catch {
        datePosted = undefined;
      }
    }

    const jobId = this.extractIdFromUrl(item.guid ?? item.link);

    return new JobPostDto({
      id: `berlinstartupjobs-${jobId}`,
      title: item.title,
      companyName,
      jobUrl: item.link,
      location: new LocationDto({ city: 'Berlin', country: 'Germany' }),
      description,
      compensation: undefined,
      datePosted,
      isRemote: false,
      emails: extractEmails(description ?? null),
      site: Site.BERLINSTARTUPJOBS,
    });
  }

  private extractIdFromUrl(url: string): string {
    try {
      const parsed = new URL(url);
      const segments = parsed.pathname.split('/').filter(Boolean);
      return segments[segments.length - 1] ?? this.hashString(url);
    } catch {
      return this.hashString(url);
    }
  }

  private hashString(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash + char) | 0;
    }
    return Math.abs(hash).toString(36);
  }
}
