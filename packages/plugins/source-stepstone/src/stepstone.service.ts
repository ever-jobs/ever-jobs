import { SourcePlugin } from '@ever-jobs/plugin';

// WIP: This source may need selector updates after live testing.
// StepStone is a React SPA with aggressive anti-bot measures.
// Uses Playwright for rendering. Currently targets Germany (.de) only.
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import * as cheerio from 'cheerio';
import {
  classifyScrapeError,
  IScraper,
  ScraperInputDto,
  JobResponseDto,
  JobPostDto,
  LocationDto,
  CompensationDto,
  CompensationInterval,
  Site,
  DescriptionFormat,
} from '@ever-jobs/models';
import {
  htmlToPlainText,
  markdownConverter,
  extractEmails,
  randomSleep,
} from '@ever-jobs/common';
import { BrowserPool } from '@ever-jobs/common';
import {
  STEPSTONE_DEFAULT_DOMAIN,
  STEPSTONE_DELAY_MIN,
  STEPSTONE_DELAY_MAX,
} from './stepstone.constants';
import { StepStoneJsonLd } from './stepstone.types';

@SourcePlugin({
  site: Site.STEPSTONE,
  name: 'StepStone',
  category: 'regional',
})
@Injectable()
export class StepStoneService implements IScraper, OnModuleDestroy {
  private readonly logger = new Logger(StepStoneService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const proxy = input.proxies?.[0] ?? undefined;
    const resultsWanted = input.resultsWanted ?? 15;
    // TODO: Support multi-country via input.country mapping
    const domain = STEPSTONE_DEFAULT_DOMAIN;
    let page;

    try {
      page = await BrowserPool.getPage({ proxy });
      const timeoutMs = (input.requestTimeout ?? 30) * 1000;

      const searchTerm = (input.searchTerm ?? 'developer').replace(/\s+/g, '-');
      const searchUrl = `https://${domain}/jobs/${encodeURIComponent(searchTerm)}`;

      this.logger.log(`StepStone: navigating to ${searchUrl}`);
      await page.goto(searchUrl, {
        waitUntil: 'domcontentloaded',
        timeout: timeoutMs,
      });

      // Wait for JS rendering
      await this.delay(6000);

      const html = await page.content();
      const jobs = this.parseSearchResults(html, domain);

      if (jobs.length === 0) {
        // TODO: Validate selectors against live StepStone rendered DOM
        this.logger.warn(
          'StepStone: zero jobs extracted — anti-bot may have blocked or selectors need updating',
        );
      }

      this.logger.log(`StepStone: extracted ${jobs.length} jobs from search`);
      return new JobResponseDto(jobs.slice(0, resultsWanted));
    } catch (err: any) {
      this.logger.error(`StepStone scrape failed: ${err.message}`);
      return new JobResponseDto([], classifyScrapeError(err));
    } finally {
      if (page) {
        const context = page.context();
        await page.close().catch(() => {});
        await context.close().catch(() => {});
      }
    }
  }

  private parseSearchResults(html: string, domain: string): JobPostDto[] {
    const $ = cheerio.load(html);
    const jobs: JobPostDto[] = [];

    // TODO: Validate selectors against live StepStone DOM
    // Try multiple known StepStone search result card patterns
    const selectors = [
      'article[data-testid="job-item"]',
      '[data-at="job-item"]',
      'article.res-1p3szyi',
      'div[data-genesis-element="BASE"] article',
      'a[data-testid="job-item-link"]',
    ];

    let cards: cheerio.Cheerio<any> | null = null;
    for (const sel of selectors) {
      const found = $(sel);
      if (found.length > 0) {
        cards = found;
        break;
      }
    }

    // Broader fallback
    if (!cards || cards.length === 0) {
      cards = $('article').filter((_, el) => {
        const links = $(el).find('a[href*="/stellenangebote--"], a[href*="/jobs--"]');
        return links.length > 0;
      });
    }

    if (!cards || cards.length === 0) {
      return [];
    }

    cards.each((_, el) => {
      try {
        const card = $(el);

        const titleEl = card.find('h2 a, h3 a, [data-at="job-item-title"]').first();
        const title = titleEl.text().trim() || card.find('a').first().text().trim();
        if (!title) return;

        let href = titleEl.attr('href') ?? card.find('a').first().attr('href') ?? '';
        if (!href) return;
        if (href.startsWith('/')) {
          href = `https://${domain}${href}`;
        }

        const company = card.find('[data-at="job-item-company-name"], .res-company-name').text().trim() || null;
        const location = card.find('[data-at="job-item-location"], .res-location').text().trim() || null;

        const id = `stepstone-${Math.abs(this.hashCode(href))}`;

        jobs.push(new JobPostDto({
          id,
          title,
          companyName: company,
          jobUrl: href,
          location: location ? new LocationDto({ city: location }) : null,
          site: Site.STEPSTONE,
        }));
      } catch {
        // Skip card errors
      }
    });

    // Try extracting JSON-LD if present (usually on detail pages, sometimes on search)
    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const json = JSON.parse($(el).html() ?? '');
        if (json['@type'] === 'JobPosting') {
          const ld = json as StepStoneJsonLd;
          const existing = jobs.find((j) => j.title === ld.title);
          if (existing && ld.description) {
            existing.description = htmlToPlainText(ld.description);
          }
          if (existing && ld.baseSalary?.value) {
            existing.compensation = new CompensationDto({
              interval: CompensationInterval.YEARLY,
              minAmount: ld.baseSalary.value.minValue ?? undefined,
              maxAmount: ld.baseSalary.value.maxValue ?? undefined,
              currency: ld.baseSalary.currency ?? 'EUR',
            });
          }
        }
      } catch {
        // Ignore JSON-LD parse errors
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
