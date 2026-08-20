import { SourcePlugin } from '@ever-jobs/plugin';

/**
 * Dice Job Search — uses the Dice REST API as primary, HTML scraping as fallback.
 *
 * The REST API (`job-search-api.svc.dhigroupinc.com/v1/dice/jobs/search`)
 * returns structured JSON data and is much more reliable than HTML scraping.
 */
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import * as cheerio from 'cheerio';
import {
  IScraper,
  classifyScrapeError,
  ScrapeDiagnostics,
  ScraperInputDto,
  JobResponseDto,
  JobPostDto,
  LocationDto,
  CompensationDto,
  CompensationInterval,
  JobType,
  Site,
} from '@ever-jobs/models';
import {
  createHttpClient,
  randomSleep,
  extractSalary,
} from '@ever-jobs/common';
import { BrowserPool } from '@ever-jobs/common';
import {
  DICE_API_URL,
  DICE_SEARCH_URL,
  DICE_API_HEADERS,
  DICE_HEADERS,
  DICE_DELAY_MIN,
  DICE_DELAY_MAX,
  DICE_PAGE_SIZE,
} from './dice.constants';
import type { DiceApiJob, DiceApiResponse } from './dice.types';

@SourcePlugin({
  site: Site.DICE,
  name: 'Dice',
  category: 'niche',
})
@Injectable()
export class DiceService implements IScraper, OnModuleDestroy {
  private readonly logger = new Logger(DiceService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const resultsWanted = input.resultsWanted ?? 15;
    // The API failure is a ROUTING SIGNAL towards the fallbacks, not an
    // outcome. Only the last surface tried decides the result, so this is
    // reported solely when every fallback also comes back empty.
    let apiFailure: ScrapeDiagnostics | undefined;

    // Primary: JSON API
    try {
      const apiJobs = await this.scrapeWithApi(input, resultsWanted);
      if (apiJobs.length > 0) {
        return new JobResponseDto(apiJobs);
      }
      this.logger.log('Dice API returned zero results, trying HTML fallback');
    } catch (err: any) {
      this.logger.warn(`Dice API failed: ${err.message}, trying HTML fallback`);
      apiFailure = classifyScrapeError(err);
    }

    // Fallback 1: cheerio HTML scraping
    const cheerioJobs = await this.scrapeWithCheerio(input, resultsWanted);
    if (cheerioJobs.length > 0) {
      return new JobResponseDto(cheerioJobs);
    }

    // Fallback 2: Playwright
    this.logger.log('Dice cheerio returned zero, falling back to Playwright');
    const playwrightJobs = await this.scrapeWithPlaywright(input, resultsWanted);
    return new JobResponseDto(
      playwrightJobs,
      playwrightJobs.length ? undefined : apiFailure,
    );
  }

  // ── Primary: REST API ────────────────────────────────────────────────

  private async scrapeWithApi(
    input: ScraperInputDto,
    resultsWanted: number,
  ): Promise<JobPostDto[]> {
    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(DICE_API_HEADERS);

    const allJobs: JobPostDto[] = [];
    let page = 1;
    const maxPages = Math.ceil(resultsWanted / DICE_PAGE_SIZE) + 1;

    while (allJobs.length < resultsWanted && page <= maxPages) {
      try {
        const url = new URL(DICE_API_URL);
        if (input.searchTerm) url.searchParams.set('q', input.searchTerm);
        if (input.location) url.searchParams.set('location', input.location);
        url.searchParams.set('page', String(page));
        url.searchParams.set('pageSize', String(DICE_PAGE_SIZE));
        url.searchParams.set('countryCode2', 'US');
        url.searchParams.set('language', 'en');

        this.logger.log(`Fetching Dice API page ${page}`);
        const response = await client.get<DiceApiResponse>(url.toString());
        const data = response.data;

        if (!data?.data?.length) break;

        const jobs = data.data.map((job) => this.processApiJob(job)).filter(Boolean) as JobPostDto[];
        allJobs.push(...jobs);

        // If we got fewer results than page size, there are no more pages
        if (data.data.length < DICE_PAGE_SIZE) break;

        page++;
        if (page <= maxPages && allJobs.length < resultsWanted) {
          await randomSleep(DICE_DELAY_MIN, DICE_DELAY_MAX);
        }
      } catch (err: any) {
        this.logger.error(`Dice API error page ${page}: ${err.message}`);
        break;
      }
    }

    return allJobs.slice(0, resultsWanted);
  }

  /** Convert a Dice API job result to a JobPostDto */
  private processApiJob(job: DiceApiJob): JobPostDto | null {
    try {
      const title = job.title;
      if (!title) return null;

      // Build job URL
      let jobUrl = job.detailsPageUrl ?? '';
      if (jobUrl && !jobUrl.startsWith('http')) {
        jobUrl = `https://www.dice.com${jobUrl}`;
      }
      if (!jobUrl && job.id) {
        jobUrl = `https://www.dice.com/job-detail/${job.id}`;
      }

      // Build location
      const locationStr = job.formattedLocation ?? job.jobLocation?.displayName ?? null;
      const location = locationStr ? new LocationDto({ city: locationStr }) : null;

      // Check remote
      const isRemote = job.isRemote ?? (locationStr?.toLowerCase().includes('remote') ?? false);

      // Build compensation
      let compensation = null;
      if (job.payRateRange?.min || job.payRateRange?.max) {
        compensation = new CompensationDto({
          interval: CompensationInterval.YEARLY,
          minAmount: job.payRateRange.min ?? null,
          maxAmount: job.payRateRange.max ?? null,
          currency: 'USD',
        });
      } else if (job.salary) {
        const parsed = extractSalary(job.salary);
        if (parsed.minAmount != null) {
          compensation = new CompensationDto({
            interval: parsed.interval as any,
            minAmount: parsed.minAmount,
            maxAmount: parsed.maxAmount,
            currency: parsed.currency ?? 'USD',
          });
        }
      }

      return new JobPostDto({
        id: `dice-${job.id ?? job.jobId ?? Math.abs(this.hashCode(jobUrl))}`,
        title,
        companyName: job.companyName ?? null,
        jobUrl,
        location,
        description: job.summary ?? null,
        compensation: compensation as any,
        datePosted: job.postedDate ?? job.modifiedDate ?? null,
        isRemote,
        jobType: job.employmentType ? [job.employmentType as JobType] : null,
        site: Site.DICE,
      });
    } catch {
      return null;
    }
  }

  // ── Fallback 1: Cheerio HTML ─────────────────────────────────────────

  private async scrapeWithCheerio(
    input: ScraperInputDto,
    resultsWanted: number,
  ): Promise<JobPostDto[]> {
    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(DICE_HEADERS);

    const allJobs: JobPostDto[] = [];
    let page = 1;
    const maxPages = Math.ceil(resultsWanted / DICE_PAGE_SIZE) + 1;

    while (allJobs.length < resultsWanted && page <= maxPages) {
      try {
        const url = new URL(DICE_SEARCH_URL);
        if (input.searchTerm) url.searchParams.set('q', input.searchTerm);
        if (input.location) url.searchParams.set('location', input.location);
        url.searchParams.set('page', String(page));
        url.searchParams.set('pageSize', String(DICE_PAGE_SIZE));
        url.searchParams.set('countryCode', 'US');
        url.searchParams.set('language', 'en');

        this.logger.log(`Fetching Dice HTML page ${page}`);
        const response = await client.get<string>(url.toString());
        const jobs = this.parseHtml(response.data);
        if (jobs.length === 0) break;

        allJobs.push(...jobs);
        page++;

        if (page <= maxPages && allJobs.length < resultsWanted) {
          await randomSleep(DICE_DELAY_MIN, DICE_DELAY_MAX);
        }
      } catch (err: any) {
        this.logger.error(`Dice HTML error page ${page}: ${err.message}`);
        break;
      }
    }

    return allJobs.slice(0, resultsWanted);
  }

  // ── Fallback 2: Playwright ───────────────────────────────────────────

  private async scrapeWithPlaywright(
    input: ScraperInputDto,
    resultsWanted: number,
  ): Promise<JobPostDto[]> {
    const proxy = input.proxies?.[0] ?? undefined;
    let page;

    try {
      page = await BrowserPool.getPage({ proxy });
      const timeoutMs = (input.requestTimeout ?? 30) * 1000;

      const url = new URL(DICE_SEARCH_URL);
      if (input.searchTerm) url.searchParams.set('q', input.searchTerm);
      if (input.location) url.searchParams.set('location', input.location);

      this.logger.log(`Dice Playwright: navigating to ${url.toString()}`);
      await page.goto(url.toString(), {
        waitUntil: 'domcontentloaded',
        timeout: timeoutMs,
      });

      await this.delay(5000);

      const html = await page.content();
      const jobs = this.parseHtml(html);

      if (jobs.length === 0) {
        this.logger.warn('Dice Playwright: zero jobs — selectors may need updating');
      }

      this.logger.log(`Dice Playwright: extracted ${jobs.length} jobs`);
      return jobs.slice(0, resultsWanted);
    } catch (err: any) {
      this.logger.error(`Dice Playwright failed: ${err.message}`);
      return [];
    } finally {
      if (page) {
        const context = page.context();
        await page.close().catch(() => {});
        await context.close().catch(() => {});
      }
    }
  }

  // ── HTML parser ──────────────────────────────────────────────────────

  private parseHtml(html: string): JobPostDto[] {
    const $ = cheerio.load(html);
    const jobs: JobPostDto[] = [];

    const selectors = [
      '[data-cy="search-card"]',
      'dhi-search-card',
      '.search-card',
      'a[data-id]',
    ];

    let cards: cheerio.Cheerio<any> | null = null;
    for (const sel of selectors) {
      const found = $(sel);
      if (found.length > 0) {
        cards = found;
        break;
      }
    }

    if (!cards || cards.length === 0) return [];

    cards.each((_, el) => {
      try {
        const card = $(el);
        const titleEl = card.find('a.card-title-link, h5 a, [data-cy="card-title"]').first();
        const title = titleEl.text().trim() || card.find('a').first().text().trim();
        if (!title) return;

        let href = titleEl.attr('href') ?? card.find('a').first().attr('href') ?? '';
        if (href && !href.startsWith('http')) href = `https://www.dice.com${href}`;
        if (!href) return;

        const company = card.find('[data-cy="search-result-company-name"], .card-company').text().trim() || null;
        const location = card.find('[data-cy="search-result-location"], .card-location').text().trim() || null;
        const salaryText = card.find('[data-cy="search-result-salary"], .card-salary').text().trim() || null;
        const dateText = card.find('[data-cy="card-posted-date"], .card-posted-date').text().trim() || null;

        let compensation = null;
        if (salaryText) {
          const parsed = extractSalary(salaryText);
          if (parsed.minAmount != null) {
            compensation = {
              interval: parsed.interval,
              minAmount: parsed.minAmount,
              maxAmount: parsed.maxAmount,
              currency: parsed.currency ?? 'USD',
            };
          }
        }

        const idMatch = href.match(/\/job-detail\/([^/?]+)/);
        const id = idMatch ? `dice-${idMatch[1]}` : `dice-${Math.abs(this.hashCode(href))}`;

        jobs.push(new JobPostDto({
          id,
          title,
          companyName: company,
          jobUrl: href,
          location: location ? new LocationDto({ city: location }) : null,
          compensation: compensation as any,
          datePosted: dateText,
          site: Site.DICE,
        }));
      } catch {
        // Skip individual card errors
      }
    });

    return jobs;
  }

  async onModuleDestroy(): Promise<void> {
    await BrowserPool.close();
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
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
