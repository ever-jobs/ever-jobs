import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
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
import { VUEJOBS_RSS_URL, VUEJOBS_DEFAULT_RESULTS, VUEJOBS_HEADERS } from './vuejobs.constants';
import { VueJobsRssItem } from './vuejobs.types';

@SourcePlugin({
  site: Site.VUEJOBS,
  name: 'VueJobs',
  category: 'niche',
})
@Injectable()
export class VueJobsService implements IScraper {
  private readonly logger = new Logger(VueJobsService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const resultsWanted = input.resultsWanted ?? VUEJOBS_DEFAULT_RESULTS;

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(VUEJOBS_HEADERS);

    this.logger.log(`Fetching VueJobs RSS feed: ${VUEJOBS_RSS_URL}`);

    try {
      const response = await client.get(VUEJOBS_RSS_URL);
      const xml = response.data;

      if (!xml || typeof xml !== 'string') {
        this.logger.warn('Empty or invalid RSS response from VueJobs');
        return new JobResponseDto([]);
      }

      const items = this.parseRssItems(xml);
      this.logger.log(`Parsed ${items.length} items from VueJobs RSS feed`);

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
          this.logger.warn(`Error mapping VueJobs item ${item.link}: ${err.message}`);
        }
      }

      this.logger.log(`VueJobs returned ${jobs.length} jobs`);
      return new JobResponseDto(jobs);
    } catch (err: any) {
      this.logger.error(`VueJobs scrape error: ${err.message}`);
      return new JobResponseDto([]);
    }
  }

  private parseRssItems(xml: string): VueJobsRssItem[] {
    const items: VueJobsRssItem[] = [];
    const itemBlocks = xml.split(/<item>/i).slice(1);

    for (const block of itemBlocks) {
      const itemContent = block.split(/<\/item>/i)[0] ?? block;

      items.push({
        title: this.extractTag(itemContent, 'title'),
        link: this.extractTag(itemContent, 'link'),
        description: this.extractTag(itemContent, 'description'),
        pubDate: this.extractTag(itemContent, 'pubDate'),
        guid: this.extractTag(itemContent, 'guid'),
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

  private matchesSearch(item: VueJobsRssItem, searchTerm: string): boolean {
    const term = searchTerm.toLowerCase();
    const title = (item.title ?? '').toLowerCase();
    const description = (item.description ?? '').toLowerCase();
    return title.includes(term) || description.includes(term);
  }

  private mapJob(item: VueJobsRssItem, descriptionFormat?: DescriptionFormat): JobPostDto | null {
    if (!item.title || !item.link) return null;

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
      id: `vuejobs-${jobId}`,
      title: item.title,
      jobUrl: item.link,
      location: new LocationDto({}),
      description,
      compensation: undefined,
      datePosted,
      isRemote: false,
      emails: extractEmails(description ?? null),
      site: Site.VUEJOBS,
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
