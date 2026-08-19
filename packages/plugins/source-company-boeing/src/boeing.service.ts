import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper,
  ScraperInputDto,
  JobResponseDto,
  JobPostDto,
  LocationDto,
  Site,
  DescriptionFormat,
} from '@ever-jobs/models';
import {
  createHttpClient,
  htmlToPlainText,
  markdownConverter,
  extractEmails,
} from '@ever-jobs/common';
import {
  BOEING_API_URL,
  BOEING_HEADERS,
  BOEING_PAGE_SIZE,
  BOEING_REQUEST_DELAY_MS,
} from './boeing.constants';
import { BoeingResponse, BoeingJob } from './boeing.types';

@SourcePlugin({
  site: Site.BOEING,
  name: 'Boeing',
  category: 'company',
})
@Injectable()
export class BoeingService implements IScraper {
  private readonly logger = new Logger(BoeingService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const maxResults = input.resultsWanted ?? 100;
    let page = 1;
    let consecutiveEmpty = 0;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });
      client.setHeaders(BOEING_HEADERS);

      while (jobs.length < maxResults && consecutiveEmpty < 3) {
        const { data } = await client.get<BoeingResponse>(BOEING_API_URL, {
          params: {
            page,
            limit: BOEING_PAGE_SIZE,
            keyword: input.searchTerm ?? '',
            location: input.location ?? '',
          },
        });

        const listings = data?.jobs ?? [];
        if (!listings.length) {
          consecutiveEmpty++;
          page++;
          await this.delay(BOEING_REQUEST_DELAY_MS);
          continue;
        }

        consecutiveEmpty = 0;

        for (const listing of listings) {
          if (jobs.length >= maxResults) break;
          const job = this.mapToJobPost(listing, input);
          if (job) jobs.push(job);
        }

        // Stop if we have fetched all available results
        const total = data?.total ?? 0;
        if (page * BOEING_PAGE_SIZE >= total) break;

        page++;
        await this.delay(BOEING_REQUEST_DELAY_MS);
      }

      this.logger.log(`Boeing: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Boeing scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }

  /**
   * Map a raw Boeing API job object into the normalised JobPostDto.
   */
  private mapToJobPost(
    raw: BoeingJob,
    input: ScraperInputDto,
  ): JobPostDto | null {
    if (!raw.title) return null;

    // --- Location ---
    const locStr = raw.location ?? '';
    const locParts = locStr.split(',').map((s) => s.trim());
    const location = locStr
      ? new LocationDto({
          city: locParts[0] ?? null,
          state: locParts[1] ?? null,
          country: locParts[2] ?? null,
        })
      : undefined;

    // --- Description ---
    let description: string | null = null;
    if (raw.description) {
      const format = input.descriptionFormat ?? DescriptionFormat.MARKDOWN;
      if (format === DescriptionFormat.MARKDOWN) {
        description = markdownConverter(raw.description);
      } else if (format === DescriptionFormat.PLAIN) {
        description = htmlToPlainText(raw.description);
      } else {
        // HTML -- keep as-is
        description = raw.description;
      }
    }

    // --- Emails ---
    const emails = extractEmails(raw.description ?? null);

    // --- URL ---
    const jobUrl =
      raw.url ?? (raw.id ? `https://jobs.boeing.com/job/${raw.id}` : '');

    // --- Remote detection ---
    const isRemote =
      locStr.toLowerCase().includes('remote') ||
      (raw.type ?? '').toLowerCase().includes('remote');

    return new JobPostDto({
      id: raw.id ?? undefined,
      site: Site.BOEING,
      title: raw.title,
      companyName: 'Boeing',
      jobUrl,
      location,
      description,
      emails: emails?.length ? emails : null,
      datePosted: raw.posted_date ?? undefined,
      department: raw.department ?? undefined,
      isRemote,
    });
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
