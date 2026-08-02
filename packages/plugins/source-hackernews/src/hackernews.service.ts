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
import { HN_JOB_STORIES_URL, HN_ITEM_URL } from './hackernews.constants';
import { HackerNewsItem } from './hackernews.types';

/** Maximum number of item IDs to fetch in a single batch. */
const BATCH_SIZE = 15;

/** How many IDs to fetch overall before filtering. */
const MAX_FETCH_IDS = 100;

@SourcePlugin({
  site: Site.HACKERNEWS,
  name: 'HackerNews',
  category: 'niche',
})
@Injectable()
export class HackerNewsService implements IScraper {
  private readonly logger = new Logger(HackerNewsService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const resultsWanted = input.resultsWanted ?? 15;

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });

    this.logger.log(
      `Fetching HackerNews jobs (resultsWanted=${resultsWanted}, search="${input.searchTerm ?? ''}")`,
    );

    try {
      // 1. Fetch list of job story IDs
      const storiesResponse = await client.get(HN_JOB_STORIES_URL);
      const storyIds: number[] = storiesResponse.data;

      if (!Array.isArray(storyIds) || storyIds.length === 0) {
        this.logger.warn('HackerNews returned empty job stories list');
        return new JobResponseDto([]);
      }

      this.logger.log(`HackerNews returned ${storyIds.length} job story IDs`);

      // 2. Determine how many IDs to fetch (fetch more than needed to allow filtering)
      const fetchCount = input.searchTerm
        ? Math.min(storyIds.length, MAX_FETCH_IDS)
        : Math.min(storyIds.length, resultsWanted * 2);

      const idsToFetch = storyIds.slice(0, fetchCount);

      // 3. Fetch items in batches using Promise.allSettled
      const items: HackerNewsItem[] = [];

      for (let i = 0; i < idsToFetch.length; i += BATCH_SIZE) {
        const batch = idsToFetch.slice(i, i + BATCH_SIZE);
        const promises = batch.map((id) =>
          client.get(HN_ITEM_URL(id)).then((res) => res.data as HackerNewsItem),
        );

        const results = await Promise.allSettled(promises);

        for (const result of results) {
          if (result.status === 'fulfilled' && result.value) {
            items.push(result.value);
          }
        }

        this.logger.debug(
          `Fetched batch ${Math.floor(i / BATCH_SIZE) + 1}: ${batch.length} items`,
        );
      }

      // 4. Filter and map to JobPostDto
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
            `Error mapping HackerNews item ${item.id}: ${err.message}`,
          );
        }
      }

      this.logger.log(`HackerNews returned ${jobs.length} jobs`);
      return new JobResponseDto(jobs);
    } catch (err: any) {
      this.logger.error(`HackerNews scrape error: ${err.message}`);
      return new JobResponseDto([]);
    }
  }

  /**
   * Check whether a job matches the given search term (case-insensitive).
   */
  private matchesSearch(item: HackerNewsItem, searchTerm: string): boolean {
    const term = searchTerm.toLowerCase();
    const title = (item.title ?? '').toLowerCase();
    const text = (item.text ?? '').toLowerCase();

    return title.includes(term) || text.includes(term);
  }

  /**
   * Try to extract company name from typical HN job titles.
   * Common patterns:
   *   "Company Name (YC S21) Is Hiring ..."
   *   "Company Name is hiring ..."
   *   "Company Name (Remote) - Position Title"
   */
  private extractCompanyName(title: string): string | null {
    // Pattern 1: "Company Name is hiring" (case-insensitive)
    const hiringMatch = title.match(/^(.+?)\s+(?:is\s+hiring|Is\s+Hiring)/i);
    if (hiringMatch) {
      let company = hiringMatch[1].trim();
      // Strip YC batch annotation like "(YC S21)" but keep it recognizable
      company = company.replace(/\s*\(YC\s+\w+\)\s*/g, ' ').trim();
      return company || null;
    }

    // Pattern 2: "Company Name - Position" or "Company Name | Position"
    const separatorMatch = title.match(/^(.+?)\s*[-|]\s+/);
    if (separatorMatch) {
      const candidate = separatorMatch[1].trim();
      // Only use if it looks like a company name (not too long, no common job keywords)
      if (candidate.length < 60 && !/engineer|developer|designer|manager/i.test(candidate)) {
        return candidate || null;
      }
    }

    return null;
  }

  /**
   * Map a raw HackerNews item to a JobPostDto.
   */
  private mapJob(
    item: HackerNewsItem,
    descriptionFormat?: DescriptionFormat,
  ): JobPostDto | null {
    if (!item.title) return null;

    // Process description (HN text field contains HTML)
    let description: string | null = item.text ?? null;
    if (description) {
      if (descriptionFormat === DescriptionFormat.PLAIN) {
        description = htmlToPlainText(description);
      } else if (descriptionFormat === DescriptionFormat.MARKDOWN) {
        description = markdownConverter(description) ?? description;
      }
    }

    // Parse date from Unix timestamp
    let datePosted: string | null = null;
    if (item.time) {
      try {
        datePosted = toDateOnly(item.time * 1000);
      } catch {
        datePosted = null;
      }
    }

    // Build job URL: prefer the item's url field; fall back to HN item page
    const jobUrl = item.url || `https://news.ycombinator.com/item?id=${item.id}`;

    // Try to extract company name from the title
    const companyName = this.extractCompanyName(item.title);

    return new JobPostDto({
      id: `hackernews-${item.id}`,
      title: item.title,
      companyName,
      jobUrl,
      description,
      datePosted,
      emails: extractEmails(description),
      site: Site.HACKERNEWS,
    });
  }
}
