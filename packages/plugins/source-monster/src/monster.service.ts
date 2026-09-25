import { SourcePlugin } from '@ever-jobs/plugin';

// WIP: Monster uses DataDome anti-bot — API endpoint may get blocked without residential proxies.
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import * as cheerio from 'cheerio';
import {
  IScraper,
  ScraperInputDto,
  JobResponseDto,
  JobPostDto,
  LocationDto,
  Site,
} from '@ever-jobs/models';
import {
  createHttpClient,
  randomSleep,
  extractSalary,
  extractEmails,
  parseLocationList,
} from '@ever-jobs/common';
import { BrowserPool } from '@ever-jobs/common';
import {
  MONSTER_API_URL,
  MONSTER_SEARCH_URL,
  MONSTER_API_PAGE_SIZE,
  MONSTER_HTML_PAGE_SIZE,
  MONSTER_DELAY_MIN,
  MONSTER_DELAY_MAX,
  MONSTER_API_HEADERS,
  MONSTER_HTML_HEADERS,
} from './monster.constants';
import type {
  MonsterSearchPayload,
  MonsterJobResult,
  MonsterSearchResponse,
} from './monster.types';

@SourcePlugin({
  site: Site.MONSTER,
  name: 'Monster',
  category: 'job-board',
})
@Injectable()
export class MonsterService implements IScraper, OnModuleDestroy {
  private readonly logger = new Logger(MonsterService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const resultsWanted = input.resultsWanted ?? 15;

    // Try Monster JSON API first (lower anti-bot protection)
    const apiJobs = await this.scrapeWithApi(input, resultsWanted);
    if (apiJobs.length > 0) {
      return new JobResponseDto(apiJobs);
    }

    // Fallback to Playwright if API returned nothing (likely DataDome block)
    this.logger.log('Monster: API returned zero results, falling back to Playwright');
    const playwrightJobs = await this.scrapeWithPlaywright(input, resultsWanted);
    return new JobResponseDto(playwrightJobs);
  }

  /**
   * Scrape using the Monster Apps API (POST with JSON body).
   */
  private async scrapeWithApi(
    input: ScraperInputDto,
    resultsWanted: number,
  ): Promise<JobPostDto[]> {
    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(MONSTER_API_HEADERS);

    const allJobs: JobPostDto[] = [];
    let offset = 0;
    const maxPages = Math.ceil(resultsWanted / MONSTER_API_PAGE_SIZE) + 1;
    let pages = 0;

    while (allJobs.length < resultsWanted && pages < maxPages) {
      try {
        const payload: MonsterSearchPayload = {
          jobQuery: {
            query: input.searchTerm ?? '',
            locations: [
              {
                address: input.location ?? '',
                country: 'us',
              },
            ],
          },
          offset,
          pageSize: MONSTER_API_PAGE_SIZE,
        };

        this.logger.log(`Fetching Monster API offset=${offset}`);
        const response = await client.post<MonsterSearchResponse>(
          MONSTER_API_URL,
          payload,
        );
        const data = response.data;

        const results = data?.jobResults ?? [];
        if (results.length === 0) break;

        for (const jobResult of results) {
          const job = this.processApiResult(jobResult);
          if (job) allJobs.push(job);
        }

        offset += MONSTER_API_PAGE_SIZE;
        pages++;

        if (pages < maxPages && allJobs.length < resultsWanted) {
          await randomSleep(MONSTER_DELAY_MIN, MONSTER_DELAY_MAX);
        }
      } catch (err: any) {
        this.logger.error(`Monster API scrape error at offset ${offset}: ${err.message}`);
        break;
      }
    }

    return allJobs.slice(0, resultsWanted);
  }

  /**
   * Fallback: use Playwright to render the Monster search page and scrape with cheerio.
   * Stealth mode is critical for bypassing DataDome protection.
   */
  private async scrapeWithPlaywright(
    input: ScraperInputDto,
    resultsWanted: number,
  ): Promise<JobPostDto[]> {
    const proxy = input.proxies?.[0] ?? undefined;
    let page;

    try {
      // Stealth mode is critical for DataDome
      page = await BrowserPool.getPage({ proxy, stealth: true });
      const timeoutMs = (input.requestTimeout ?? 30) * 1000;

      const url = new URL(MONSTER_SEARCH_URL);
      if (input.searchTerm) url.searchParams.set('q', input.searchTerm);
      if (input.location) url.searchParams.set('where', input.location);
      url.searchParams.set('page', '1');

      this.logger.log(`Monster Playwright: navigating to ${url.toString()}`);
      await page.goto(url.toString(), {
        waitUntil: 'domcontentloaded',
        timeout: timeoutMs,
      });

      // Wait 6-8 seconds for DataDome challenge resolution and JS hydration
      const waitMs = 6000 + Math.floor(Math.random() * 2000);
      await this.delay(waitMs);

      const html = await page.content();
      const jobs = this.parseHtml(html);

      if (jobs.length === 0) {
        // TODO: Validate selectors against live Monster rendered DOM
        this.logger.warn('Monster Playwright: zero jobs extracted — selectors may need updating');
      }

      this.logger.log(`Monster Playwright: extracted ${jobs.length} jobs`);
      return jobs.slice(0, resultsWanted);
    } catch (err: any) {
      this.logger.error(`Monster Playwright scrape failed: ${err.message}`);
      return [];
    } finally {
      if (page) {
        const context = page.context();
        await page.close().catch(() => {});
        await context.close().catch(() => {});
      }
    }
  }

  /**
   * Convert a Monster API job result to a JobPostDto.
   */
  private processApiResult(job: MonsterJobResult): JobPostDto | null {
    if (!job.jobId && !job.jobDetailUrl) return null;

    const title = job.title?.trim() ?? null;
    if (!title) return null;

    // Build job URL — ensure starts with https://www.monster.com
    let jobUrl = job.jobDetailUrl ?? '';
    if (jobUrl && !jobUrl.startsWith('http')) {
      jobUrl = `https://www.monster.com${jobUrl.startsWith('/') ? '' : '/'}${jobUrl}`;
    }

    // Structured city/stateProvince when both are present; otherwise the
    // formattedLocation / city label goes through the shared parser.
    let location: LocationDto | null = null;
    let locations: LocationDto[] = [];
    if (job.city && job.stateProvince) {
      location = new LocationDto({ city: job.city, state: job.stateProvince });
      locations = [location];
    } else {
      const parsed = parseLocationList([job.formattedLocation ?? job.city ?? null]);
      location = parsed.location;
      locations = parsed.locations;
    }

    // Parse date
    let datePosted: string | null = null;
    if (job.datePosted) {
      try {
        datePosted = new Date(job.datePosted).toISOString();
      } catch {
        datePosted = job.datePosted;
      }
    }

    // Parse salary
    let compensation = null;
    if (job.salaryInfo) {
      const parsed = extractSalary(job.salaryInfo);
      if (parsed.minAmount != null) {
        compensation = {
          interval: parsed.interval,
          minAmount: parsed.minAmount,
          maxAmount: parsed.maxAmount,
          currency: parsed.currency ?? 'USD',
        };
      }
    }

    // Extract emails from description if available
    const emails = job.description ? extractEmails(job.description) : null;

    return new JobPostDto({
      id: `monster-${job.jobId}`,
      title,
      companyName: job.company?.name?.trim() ?? null,
      jobUrl,
      location,
      ...(locations.length > 0 ? { locations } : {}),
      compensation: compensation as any,
      datePosted,
      description: job.description ?? null,
      emails: emails && emails.length > 0 ? emails : null,
      site: Site.MONSTER,
    });
  }

  /**
   * Parse Monster HTML search results using cheerio.
   */
  private parseHtml(html: string): JobPostDto[] {
    const $ = cheerio.load(html);
    const jobs: JobPostDto[] = [];

    // TODO: Validate selectors against live Monster pages
    // Monster job cards use SVX-based data attributes and various class patterns
    const selectors = [
      '[data-testid="svx-job-result"]',
      '.job-search-resultsstyle__JobCardComponent',
      '.results-card',
      '[data-test-id="svx-job-result-card"]',
    ];

    let cards: cheerio.Cheerio<any> | null = null;
    for (const sel of selectors) {
      const found = $(sel);
      if (found.length > 0) {
        cards = found;
        break;
      }
    }

    if (!cards || cards.length === 0) {
      return [];
    }

    cards.each((_, el) => {
      try {
        const card = $(el);

        // Extract title
        const titleEl = card
          .find('[data-testid="jobTitle"], h3 a, .job-cardstyle__JobCardTitle a')
          .first();
        const title =
          titleEl.text().trim() || card.find('a').first().text().trim();
        if (!title) return;

        // Extract company
        const company =
          card
            .find('[data-testid="company"], .job-cardstyle__JobCardCompany, .company')
            .text()
            .trim() || null;

        // Extract location
        const location =
          card
            .find('[data-testid="jobLocation"], .job-cardstyle__JobCardLocation, .location')
            .text()
            .trim() || null;
        const locationParsed = parseLocationList([location]);

        // Extract salary
        const salaryText =
          card
            .find('[data-testid="svx_jobCard-salary"], .job-cardstyle__JobCardSalary, .salary')
            .text()
            .trim() || null;

        // Extract URL from the main anchor href
        let href =
          titleEl.attr('href') ??
          card.find('a').first().attr('href') ??
          '';
        if (!href) return;

        // Build full jobUrl — ensure starts with https://www.monster.com
        if (href.startsWith('/')) {
          href = `https://www.monster.com${href}`;
        } else if (!href.startsWith('http')) {
          href = `https://www.monster.com/${href}`;
        }

        // Extract date posted
        const dateText =
          card.find('time[datetime]').attr('datetime') ??
          card.find('.job-cardstyle__JobCardDate, .posted-date').text().trim() ??
          null;

        // Build unique ID from URL hash
        const id = `monster-${Math.abs(this.hashCode(href))}`;

        // Parse salary with extractSalary
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

        // Extract emails from description snippet if available
        const snippet =
          card.find('.job-cardstyle__JobCardDescription, .job-description, p').first().text().trim() || null;
        const emails = snippet ? extractEmails(snippet) : null;

        jobs.push(
          new JobPostDto({
            id,
            title,
            companyName: company,
            jobUrl: href,
            location: locationParsed.location,
            ...(locationParsed.locations.length > 0
              ? { locations: locationParsed.locations }
              : {}),
            compensation: compensation as any,
            datePosted: dateText,
            description: snippet,
            emails: emails && emails.length > 0 ? emails : null,
            site: Site.MONSTER,
          }),
        );
      } catch {
        // Skip individual card parse errors
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
