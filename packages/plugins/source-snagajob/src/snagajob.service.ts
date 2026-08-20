import { SourcePlugin } from '@ever-jobs/plugin';

/**
 * Snagajob (snagajob.com) — hourly and part-time job board.
 *
 * Uses their public search API endpoint which returns JSON.
 */
import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  ScrapeDiagnostics,
  IScraper,
  ScraperInputDto,
  JobResponseDto,
  JobPostDto,
  LocationDto,
  CompensationDto,
  CompensationInterval,
  Site,
} from '@ever-jobs/models';
import { createHttpClient, randomSleep, stripHtmlTags } from '@ever-jobs/common';

const SNAGAJOB_API_URL = 'https://www.snagajob.com/api/search';
const SNAGAJOB_BASE_URL = 'https://www.snagajob.com';
const PAGE_SIZE = 20;

const HEADERS: Record<string, string> = {
  Accept: 'application/json',
  'Content-Type': 'application/json',
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
};

@SourcePlugin({
  site: Site.SNAGAJOB,
  name: 'Snagajob',
  category: 'job-board',
})
@Injectable()
export class SnagajobService implements IScraper {
  private readonly logger = new Logger(SnagajobService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const resultsWanted = input.resultsWanted ?? 15;
    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(HEADERS);

    const allJobs: JobPostDto[] = [];
    let diagnostics: ScrapeDiagnostics | undefined;
    let page = 0;
    const maxPages = Math.ceil(resultsWanted / PAGE_SIZE) + 1;

    while (allJobs.length < resultsWanted && page < maxPages) {
      try {
        const url = new URL(SNAGAJOB_API_URL);
        if (input.searchTerm) url.searchParams.set('q', input.searchTerm);
        if (input.location) url.searchParams.set('location', input.location);
        url.searchParams.set('radius', '25');
        url.searchParams.set('page', String(page));
        url.searchParams.set('pageSize', String(PAGE_SIZE));

        this.logger.log(`Fetching Snagajob page ${page + 1}`);
        const response = await client.get<any>(url.toString());
        const data = response.data;

        const rawJobs = data?.jobs ?? data?.results ?? data?.data ?? [];
        if (!Array.isArray(rawJobs) || rawJobs.length === 0) break;

        for (const raw of rawJobs) {
          const job = this.processJob(raw);
          if (job) allJobs.push(job);
        }

        if (rawJobs.length < PAGE_SIZE) break;
        page++;

        if (page < maxPages && allJobs.length < resultsWanted) {
          await randomSleep(1500, 3000);
        }
      } catch (err: any) {
        this.logger.error(`Snagajob error page ${page + 1}: ${err.message}`);
        break;
        diagnostics = classifyScrapeError(err);
      }
    }

    return new JobResponseDto(allJobs.slice(0, resultsWanted), diagnostics);
  }

  private processJob(raw: any): JobPostDto | null {
    try {
      const title = raw.title ?? raw.jobTitle;
      if (!title) return null;

      let jobUrl = raw.url ?? raw.detailUrl ?? raw.applyUrl ?? '';
      if (jobUrl && !jobUrl.startsWith('http')) {
        jobUrl = `${SNAGAJOB_BASE_URL}${jobUrl}`;
      }

      const locationStr = raw.location ?? raw.city ?? null;
      const location = locationStr
        ? new LocationDto({
            city: raw.city ?? locationStr,
            state: raw.state ?? null,
          })
        : null;

      let compensation = null;
      const payMin = raw.payMin ?? raw.minPay ?? raw.salaryMin;
      const payMax = raw.payMax ?? raw.maxPay ?? raw.salaryMax;
      if (payMin || payMax) {
        compensation = new CompensationDto({
          interval: CompensationInterval.HOURLY,
          minAmount: payMin ?? null,
          maxAmount: payMax ?? null,
          currency: 'USD',
        });
      }

      const description = raw.description ?? raw.snippet ?? null;

      return new JobPostDto({
        id: `snagajob-${raw.id ?? raw.jobId ?? Math.abs(this.hashCode(jobUrl))}`,
        title,
        companyName: raw.company ?? raw.companyName ?? raw.employer ?? null,
        jobUrl,
        location,
        description: description ? stripHtmlTags(description).slice(0, 500) : null,
        compensation: compensation as any,
        datePosted: raw.postedDate ?? raw.datePosted ?? null,
        isRemote: false, // Snagajob is primarily local hourly work
        jobType: raw.jobType ? [raw.jobType.toLowerCase()] : null,
        site: Site.SNAGAJOB,
      });
    } catch {
      return null;
    }
  }

  private hashCode(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash |= 0;
    }
    return hash;
  }
}
