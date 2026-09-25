import { SourcePlugin } from '@ever-jobs/plugin';

// WIP: CareerBuilder uses Cloudflare protection — likely needs residential proxies for reliable scraping.
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
import { createHttpClient, extractEmails, extractSalary, parseLocationList, randomSleep } from '@ever-jobs/common';
import { BrowserPool } from '@ever-jobs/common';
import {
  CB_SEARCH_URL,
  CB_HEADERS,
  CB_DELAY_MIN,
  CB_DELAY_MAX,
  CB_PAGE_SIZE,
} from './careerbuilder.constants';

@SourcePlugin({
  site: Site.CAREERBUILDER,
  name: 'CareerBuilder',
  category: 'job-board',
})
@Injectable()
export class CareerBuilderService implements IScraper, OnModuleDestroy {
  private readonly logger = new Logger(CareerBuilderService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const resultsWanted = input.resultsWanted ?? 15;

    // Try cheerio-based HTTP scraping first
    const cheerioJobs = await this.scrapeWithCheerio(input, resultsWanted);
    if (cheerioJobs.length > 0) {
      return new JobResponseDto(cheerioJobs);
    }

    // Fallback to Playwright if cheerio returned nothing (likely Cloudflare block)
    this.logger.log('CareerBuilder: cheerio returned zero results, falling back to Playwright');
    const playwrightJobs = await this.scrapeWithPlaywright(input, resultsWanted);
    return new JobResponseDto(playwrightJobs);
  }

  private async scrapeWithCheerio(
    input: ScraperInputDto,
    resultsWanted: number,
  ): Promise<JobPostDto[]> {
    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(CB_HEADERS);

    const allJobs: JobPostDto[] = [];
    let page = 1;
    const maxPages = Math.ceil(resultsWanted / CB_PAGE_SIZE) + 1;

    while (allJobs.length < resultsWanted && page <= maxPages) {
      try {
        const url = new URL(CB_SEARCH_URL);
        if (input.searchTerm) url.searchParams.set('keywords', input.searchTerm);
        if (input.location) url.searchParams.set('location', input.location);
        url.searchParams.set('page_number', String(page));

        this.logger.log(`Fetching CareerBuilder search page ${page}`);
        const response = await client.get<string>(url.toString());
        const html = response.data;

        const jobs = this.parseHtml(html);
        if (jobs.length === 0) break;

        allJobs.push(...jobs);
        page++;

        if (page <= maxPages && allJobs.length < resultsWanted) {
          await randomSleep(CB_DELAY_MIN, CB_DELAY_MAX);
        }
      } catch (err: any) {
        this.logger.error(`CareerBuilder cheerio scrape error page ${page}: ${err.message}`);
        break;
      }
    }

    return allJobs.slice(0, resultsWanted);
  }

  private async scrapeWithPlaywright(
    input: ScraperInputDto,
    resultsWanted: number,
  ): Promise<JobPostDto[]> {
    const proxy = input.proxies?.[0] ?? undefined;
    let page;

    try {
      // Stealth mode is critical for bypassing Cloudflare protection
      page = await BrowserPool.getPage({ proxy, stealth: true });
      const timeoutMs = (input.requestTimeout ?? 30) * 1000;

      const url = new URL(CB_SEARCH_URL);
      if (input.searchTerm) url.searchParams.set('keywords', input.searchTerm);
      if (input.location) url.searchParams.set('location', input.location);

      this.logger.log(`CareerBuilder Playwright: navigating to ${url.toString()}`);
      await page.goto(url.toString(), {
        waitUntil: 'domcontentloaded',
        timeout: timeoutMs,
      });

      // Wait 5-7 seconds for Cloudflare challenge resolution and JS hydration
      const waitMs = 5000 + Math.floor(Math.random() * 2000);
      await this.delay(waitMs);

      const html = await page.content();
      const jobs = this.parseHtml(html);

      if (jobs.length === 0) {
        // TODO: Validate selectors against live CareerBuilder rendered DOM
        this.logger.warn('CareerBuilder Playwright: zero jobs extracted — selectors may need updating');
      }

      this.logger.log(`CareerBuilder Playwright: extracted ${jobs.length} jobs`);
      return jobs.slice(0, resultsWanted);
    } catch (err: any) {
      this.logger.error(`CareerBuilder Playwright scrape failed: ${err.message}`);
      return [];
    } finally {
      if (page) {
        const context = page.context();
        await page.close().catch(() => {});
        await context.close().catch(() => {});
      }
    }
  }

  private parseHtml(html: string): JobPostDto[] {
    const $ = cheerio.load(html);
    const jobs: JobPostDto[] = [];

    // TODO: Validate selectors against live CareerBuilder pages
    // CareerBuilder job cards use data-job-did attributes and various class patterns
    const selectors = [
      '[data-job-did]',
      '.data-results-content-parent .data-results-content',
      '.job-listing-item',
      'a.data-results-content',
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
          .find('.data-results-title, h2 a, [data-cb-type="title"]')
          .first();
        const title = titleEl.text().trim() || card.find('a').first().text().trim();
        if (!title) return;

        // Extract company
        const company =
          card.find('.data-details .data-company, [data-cb-type="company"]').text().trim() || null;

        // Extract location
        const location =
          card.find('.data-details .data-location, [data-cb-type="location"]').text().trim() || null;
        const locationParsed = parseLocationList([location]);

        // Extract salary
        const salaryText =
          card.find('.data-salary, [data-cb-type="salary"]').text().trim() || null;

        // Extract URL from the main anchor href
        let href =
          titleEl.attr('href') ??
          card.find('a').first().attr('href') ??
          card.attr('href') ??
          '';
        if (!href) return;

        // Build full jobUrl — ensure starts with https://www.careerbuilder.com
        if (href.startsWith('/')) {
          href = `https://www.careerbuilder.com${href}`;
        } else if (!href.startsWith('http')) {
          href = `https://www.careerbuilder.com/${href}`;
        }

        // Extract date posted
        const dateText =
          card.find('.data-posted-date, time[datetime]').first().text().trim() || null;
        const dateAttr = card.find('time[datetime]').attr('datetime') ?? dateText;

        // Build unique ID from data-job-did attribute or hash of URL
        const jobDid = card.attr('data-job-did');
        const id = jobDid
          ? `cb-${jobDid}`
          : `cb-${Math.abs(this.hashCode(href))}`;

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
        const snippet = card.find('.data-snapshot, .job-description, p').first().text().trim() || null;
        const emails = snippet ? extractEmails(snippet) : null;

        jobs.push(
          new JobPostDto({
            id,
            title,
            companyName: company,
            jobUrl: href,
            location: location ? locationParsed.location : null,
            ...(locationParsed.locations.length > 0
              ? { locations: locationParsed.locations }
              : {}),
            compensation: compensation as any,
            datePosted: dateAttr,
            description: snippet,
            emails: emails && emails.length > 0 ? emails : null,
            site: Site.CAREERBUILDER,
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
