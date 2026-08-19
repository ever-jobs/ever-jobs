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
  NVIDIA_SEARCH_ENDPOINT, NVIDIA_HEADERS,
  NVIDIA_PAGE_SIZE, NVIDIA_REQUEST_DELAY_MS, NVIDIA_BASE_URL,
} from './nvidia.constants';

/** Eightfold position shape (shared with Microsoft) */
interface EightfoldPosition {
  id: string;
  displayJobId?: string;
  name?: string;
  locations?: string[];
  department?: string;
  workLocationOption?: string;
  postedTs?: number;
  positionUrl?: string;
}

@SourcePlugin({
  site: Site.NVIDIA,
  name: 'NVIDIA',
  category: 'company',
})
@Injectable()
export class NvidiaService implements IScraper {
  private readonly logger = new Logger(NvidiaService.name);

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
      client.setHeaders(NVIDIA_HEADERS);

      while (jobs.length < maxResults && consecutiveEmpty < 3) {
        const { data } = await client.get<{ data?: { positions?: EightfoldPosition[] } }>(
          NVIDIA_SEARCH_ENDPOINT,
          {
            params: {
              domain: 'nvidia.com',
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
          start += NVIDIA_PAGE_SIZE;
          await this.delay(NVIDIA_REQUEST_DELAY_MS);
          continue;
        }

        consecutiveEmpty = 0;
        for (const p of positions) {
          if (jobs.length >= maxResults) break;
          const job = this.mapToJobPost(p);
          if (job) jobs.push(job);
        }

        start += NVIDIA_PAGE_SIZE;
        await this.delay(NVIDIA_REQUEST_DELAY_MS);
      }

      this.logger.log(`Nvidia: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Nvidia scrape failed: ${err.message}`);
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
      ? `${NVIDIA_BASE_URL}${p.positionUrl}`
      : undefined;

    return new JobPostDto({
      id: p.id ?? undefined,
      site: Site.NVIDIA,
      title: p.name,
      companyName: 'NVIDIA',
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
