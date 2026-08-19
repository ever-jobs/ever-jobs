import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient,
  toDateOnly,
} from '@ever-jobs/common';
import {
  ZOOM_SEARCH_ENDPOINT, ZOOM_HEADERS,
  ZOOM_PAGE_SIZE, ZOOM_REQUEST_DELAY_MS, ZOOM_BASE_URL,
} from './zoom.constants';
import { EightfoldSearchResponse, EightfoldPosition } from './zoom.types';

@SourcePlugin({
  site: Site.ZOOM,
  name: 'Zoom',
  category: 'company',
})
@Injectable()
export class ZoomService implements IScraper {
  private readonly logger = new Logger(ZoomService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const maxResults = input.resultsWanted ?? 100;
    let start = 0;
    let consecutiveEmpty = 0;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });
      client.setHeaders(ZOOM_HEADERS);

      while (jobs.length < maxResults && consecutiveEmpty < 3) {
        const { data } = await client.get<EightfoldSearchResponse>(
          ZOOM_SEARCH_ENDPOINT,
          {
            params: {
              domain: 'zoom.eightfold.ai',
              query: input.searchTerm ?? '',
              location: input.location ?? '',
              start,
              sort_by: 'timestamp',
            },
          },
        );

        const positions = data?.data?.positions ?? [];
        if (!positions.length) {
          consecutiveEmpty++;
          start += ZOOM_PAGE_SIZE;
          await this.delay(ZOOM_REQUEST_DELAY_MS);
          continue;
        }

        consecutiveEmpty = 0;
        for (const p of positions) {
          if (jobs.length >= maxResults) break;
          const job = this.mapToJobPost(p);
          if (job) jobs.push(job);
        }

        start += ZOOM_PAGE_SIZE;
        await this.delay(ZOOM_REQUEST_DELAY_MS);
      }

      this.logger.log(`Zoom: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Zoom scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }

  private mapToJobPost(p: EightfoldPosition): JobPostDto | null {
    if (!p.name) return null;

    const locStr = p.locations?.[0] ?? '';
    const locParts = locStr.split(',').map((s) => s.trim());

    const url = p.positionUrl
      ? `${ZOOM_BASE_URL}${p.positionUrl}`
      : undefined;

    return new JobPostDto({
      id: p.id ?? undefined,
      site: Site.ZOOM,
      title: p.name,
      companyName: 'Zoom',
      jobUrl: url,
      location: new LocationDto({
        city: locParts[0] ?? null,
        state: locParts[1] ?? null,
        country: locParts[2] ?? null,
      }),
      department: p.department ?? undefined,
      datePosted: p.postedTs
        ? toDateOnly(p.postedTs * 1000)
        : undefined,
      atsId: p.displayJobId ?? undefined,
    });
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
