import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient } from '@ever-jobs/common';
import { stripHtmlTags } from '@ever-jobs/common';

const API_URL = 'https://www.uber.com/api/loadSearchJobsResults';
const PAGE_SIZE = 50;
const DELAY_MS = 500;
const DEFAULT_LOCALE = 'en';

const UBER_HEADERS: Record<string, string> = {
  'Content-Type': 'application/json',
  Accept: 'application/json',
  'User-Agent': 'Mozilla/5.0',
  'x-csrf-token': 'x',
};

interface UberJob {
  id?: number;
  title?: string;
  description?: string;
  absolute_url?: string;
  country?: string;
  city?: string;
  region?: string;
  department?: string;
  team?: string;
  sub_team?: string;
  creation_date?: string;
  updated_date?: string;
  time_type?: string;
  level?: string;
}

@SourcePlugin({
  site: Site.UBER,
  name: 'Uber',
  category: 'company',
})
@Injectable()
export class UberService implements IScraper {
  private readonly logger = new Logger(UberService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const maxResults = input.resultsWanted ?? 100;
    let page = 0;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });
      client.setHeaders(UBER_HEADERS);

      while (jobs.length < maxResults) {
        const { data } = await client.post<{
          data?: { results?: UberJob[]; totalResults?: number };
        }>(API_URL, {
          params: {
            location: [],
            department: [],
            team: [],
          },
          limit: PAGE_SIZE,
          page,
          localeCode: DEFAULT_LOCALE,
        });

        const results = data?.data?.results ?? [];
        if (!results.length) break;

        for (const j of results) {
          if (jobs.length >= maxResults) break;
          const job = this.mapToJobPost(j);
          if (job) jobs.push(job);
        }

        const total = data?.data?.totalResults ?? 0;
        if ((page + 1) * PAGE_SIZE >= total) break;
        page++;
        await this.delay(DELAY_MS);
      }

      this.logger.log(`Uber: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Uber scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }

  private mapToJobPost(j: UberJob): JobPostDto | null {
    if (!j.title) return null;

    return new JobPostDto({
      id: j.id?.toString() ?? undefined,
      site: Site.UBER,
      title: j.title,
      companyName: 'Uber',
      jobUrl: j.absolute_url ?? undefined,
      location: new LocationDto({
        city: j.city ?? null,
        state: j.region ?? null,
        country: j.country ?? null,
      }),
      description: j.description ? stripHtmlTags(j.description) : null,
      department: j.department ?? undefined,
      team: j.team ?? j.sub_team ?? undefined,
      employmentType: j.time_type ?? undefined,
      datePosted: j.creation_date ?? undefined,
    });
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
