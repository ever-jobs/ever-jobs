import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site,
  LocationDto,
} from '@ever-jobs/models';
import { BrowserPool } from '@ever-jobs/common';

const SEARCH_URL = 'https://lifeattiktok.com/search';
const DELAY_MS = 1500;

/**
 * Scrapes TikTok careers from lifeattiktok.com using headless Chromium.
 *
 * The old REST API (api.lifeattiktok.com) was decommissioned — the careers
 * site is now a client-side rendered Next.js SPA that requires JavaScript
 * execution to load job listings.
 */
@Injectable()
export class TikTokService implements IScraper, OnModuleDestroy {
  private readonly logger = new Logger(TikTokService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const maxResults = input.resultsWanted ?? 100;

    let page;
    try {
      // Pick first proxy if available (BrowserPool applies it at context level)
      const proxy = input.proxies?.[0] ?? undefined;
      page = await BrowserPool.getPage({ proxy });

      // 1. Navigate to the search page with optional keyword
      const url = new URL(SEARCH_URL);
      if (input.searchTerm) {
        url.searchParams.set('keyword', input.searchTerm);
      }

      const timeoutMs = ((input.requestTimeout ?? 30) * 1000);

      this.logger.log(`Navigating to ${url.toString()} (timeout=${timeoutMs}ms)`);
      await page.goto(url.toString(), {
        waitUntil: 'domcontentloaded',
        timeout: timeoutMs,
      });

      // 2. Wait for client-side hydration (Next.js SPA renders job cards via JS)
      await this.delay(8_000);

      // 3. Check for job cards — each card is an <a> linking to /search/{jobId}
      const jobIdPattern = /\/search\/(\d{10,})/;
      let cards = await page.$$('a[href*="/search/"]');
      cards = cards.filter(async (c) => {
        const href = await c.getAttribute('href');
        return href && jobIdPattern.test(href);
      });

      if (!cards.length) {
        this.logger.warn('No job cards found on TikTok search page');
        return { jobs };
      }

      // 4. Scroll to load more results if needed (infinite scroll)
      let previousCount = 0;
      let scrollAttempts = 0;
      const maxScrollAttempts = Math.ceil(maxResults / 10);

      while (scrollAttempts < maxScrollAttempts) {
        const allCards = await page.$$('a[href*="/search/"]');
        const currentCount = allCards.length;

        if (currentCount >= maxResults || currentCount === previousCount) break;

        previousCount = currentCount;
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await this.delay(DELAY_MS);
        scrollAttempts++;
      }

      // 5. Re-fetch all cards after scrolling
      const allCards = await page.$$('a[href*="/search/"]');
      this.logger.log(`Found ${allCards.length} job elements on page`);

      // 6. Extract structured data from each card
      //    DOM structure per card:
      //      <a href="/search/{id}">
      //        <div>
      //          <span class="...font-bold...">Job Title</span>    (1st span)
      //          <span class="...tt-text...">City</span>           (2nd span)
      //          <span class="...tt-text...">Department</span>     (3rd span)
      //          <span class="...tt-text...">Employment Type</span>(4th span)
      for (const el of allCards) {
        if (jobs.length >= maxResults) break;

        try {
          const href = await el.getAttribute('href');
          const match = href?.match(jobIdPattern);
          if (!match) continue;

          const jobId = match[1];

          // Extract text from span children in order: title, city, department, type
          const spans = await el.$$('span');
          const texts: string[] = [];
          for (const span of spans) {
            const t = ((await span.textContent()) ?? '').trim();
            if (t) texts.push(t);
          }

          const title = texts[0] || null;
          if (!title) continue;

          const city = texts[1] || null;
          const department = texts[2] || undefined;
          const employmentType = texts[3] || undefined;

          const jobUrl = href?.startsWith('http')
            ? href
            : `${SEARCH_URL}/${jobId}`;

          jobs.push(new JobPostDto({
            id: jobId,
            site: Site.TIKTOK,
            title,
            companyName: 'TikTok',
            jobUrl,
            location: new LocationDto({ city, country: null }),
            department,
            employmentType,
          }));
        } catch (err: any) {
          this.logger.debug(`Failed to parse job card: ${err.message}`);
        }
      }

      this.logger.log(`TikTok: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`TikTok scrape failed: ${err.message}`);
    } finally {
      if (page) {
        const context = page.context();
        await page.close().catch(() => {});
        await context.close().catch(() => {});
      }
    }

    return { jobs };
  }

  async onModuleDestroy(): Promise<void> {
    await BrowserPool.close();
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
