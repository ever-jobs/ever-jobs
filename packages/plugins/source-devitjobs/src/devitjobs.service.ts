import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper,
  ScraperInputDto,
  JobResponseDto,
  JobPostDto,
  LocationDto,
  CompensationDto,
  CompensationInterval,
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
import { DEVITJOBS_FEED_URL, DEVITJOBS_DEFAULT_RESULTS, DEVITJOBS_MAX_RESULTS, DEVITJOBS_HEADERS } from './devitjobs.constants';
import { DevITJobsXmlItem } from './devitjobs.types';

@SourcePlugin({
  site: Site.DEVITJOBS,
  name: 'DevITJobs',
  category: 'niche',
})
@Injectable()
export class DevITJobsService implements IScraper {
  private readonly logger = new Logger(DevITJobsService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const resultsWanted = Math.min(
      input.resultsWanted ?? DEVITJOBS_DEFAULT_RESULTS,
      DEVITJOBS_MAX_RESULTS,
    );

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(DEVITJOBS_HEADERS);

    this.logger.log(`Fetching DevITjobs feed: ${DEVITJOBS_FEED_URL}`);

    try {
      const response = await client.get(DEVITJOBS_FEED_URL);
      const xml = response.data;

      if (!xml || typeof xml !== 'string') {
        this.logger.warn('Empty or invalid XML response from DevITjobs');
        return new JobResponseDto([]);
      }

      const items = this.parseXmlItems(xml);
      this.logger.log(`Parsed ${items.length} items from DevITjobs feed`);

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
          this.logger.warn(`Error mapping DevITjobs item ${item.link}: ${err.message}`);
        }
      }

      this.logger.log(`DevITjobs returned ${jobs.length} jobs`);
      return new JobResponseDto(jobs);
    } catch (err: any) {
      this.logger.error(`DevITjobs scrape error: ${err.message}`);
      return new JobResponseDto([], classifyScrapeError(err));
    }
  }

  private parseXmlItems(xml: string): DevITJobsXmlItem[] {
    const items: DevITJobsXmlItem[] = [];
    // DevITjobs uses <job> elements (not standard RSS <item>)
    // Try <job> first, fall back to <item> if not found
    let blocks = xml.split(/<job>/i).slice(1);
    let closeTag = /<\/job>/i;

    if (blocks.length === 0) {
      blocks = xml.split(/<item>/i).slice(1);
      closeTag = /<\/item>/i;
    }

    for (const block of blocks) {
      const content = block.split(closeTag)[0] ?? block;

      items.push({
        title: this.extractTag(content, 'title'),
        link: this.extractTag(content, 'link') ?? this.extractTag(content, 'url'),
        description: this.extractTag(content, 'description') ?? this.extractTag(content, 'content'),
        company: this.extractTag(content, 'company') ?? this.extractTag(content, 'employer'),
        location: this.extractTag(content, 'location'),
        salary: this.extractTag(content, 'salary'),
        pubDate: this.extractTag(content, 'pubDate') ?? this.extractTag(content, 'date'),
        category: this.extractTag(content, 'category'),
        type: this.extractTag(content, 'type'),
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

  private matchesSearch(item: DevITJobsXmlItem, searchTerm: string): boolean {
    const term = searchTerm.toLowerCase();
    const title = (item.title ?? '').toLowerCase();
    const description = (item.description ?? '').toLowerCase();
    const company = (item.company ?? '').toLowerCase();
    const category = (item.category ?? '').toLowerCase();
    return title.includes(term) || description.includes(term) || company.includes(term) || category.includes(term);
  }

  private mapJob(item: DevITJobsXmlItem, descriptionFormat?: DescriptionFormat): JobPostDto | null {
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

    const compensation = this.parseSalary(item.salary);

    const location = new LocationDto({
      city: item.location ?? null,
    });

    let datePosted: string | undefined;
    if (item.pubDate) {
      try {
        datePosted = toDateOnly(item.pubDate) ?? undefined;
      } catch {
        datePosted = undefined;
      }
    }

    const isRemote = (item.type ?? '').toLowerCase().includes('remote') ||
      (item.location ?? '').toLowerCase().includes('remote');

    const jobId = this.extractIdFromUrl(item.link);

    return new JobPostDto({
      id: `devitjobs-${jobId}`,
      title: item.title,
      companyName: item.company ?? null,
      jobUrl: item.link,
      location,
      description,
      compensation: compensation ?? undefined,
      datePosted,
      isRemote,
      emails: extractEmails(description ?? null),
      site: Site.DEVITJOBS,
    });
  }

  private parseSalary(salaryStr: string | null): CompensationDto | null {
    if (!salaryStr) return null;

    // Try to extract numeric amounts from patterns like "$120,000 - 140,000 per year"
    const amounts = salaryStr.match(/[\d,]+/g);
    if (!amounts || amounts.length === 0) return null;

    const values = amounts
      .map(a => parseInt(a.replace(/,/g, ''), 10))
      .filter(v => v > 100); // Filter out noise

    if (values.length === 0) return null;

    const isYearly = /year|annual|annum/i.test(salaryStr);
    const isHourly = /hour|hr/i.test(salaryStr);

    // Detect currency
    let currency = 'USD';
    if (/€|EUR/i.test(salaryStr)) currency = 'EUR';
    else if (/£|GBP/i.test(salaryStr)) currency = 'GBP';
    else if (/PLN|zł/i.test(salaryStr)) currency = 'PLN';
    else if (/CHF/i.test(salaryStr)) currency = 'CHF';

    return new CompensationDto({
      interval: isHourly ? CompensationInterval.HOURLY : CompensationInterval.YEARLY,
      minAmount: values[0] ?? null,
      maxAmount: values.length > 1 ? values[1] : null,
      currency,
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
