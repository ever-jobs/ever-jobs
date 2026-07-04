import { SourcePlugin } from '@ever-jobs/plugin';

// WIP: This source may need selector updates after live testing.
// SimplyHired is owned by Indeed and may have anti-bot measures.
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import * as cheerio from 'cheerio';
import {
  IScraper,
  ScraperInputDto,
  JobResponseDto,
  JobPostDto,
  LocationDto,
  Site,
  DescriptionFormat,
  getJobTypeFromString,
} from '@ever-jobs/models';
import {
  createHttpClient,
  randomSleep,
  extractSalary,
  extractEmails,
  htmlToPlainText,
  markdownConverter,
  parseJobPostingLd,
  jobPostingLdToCompensation,
} from '@ever-jobs/common';
import { BrowserPool } from '@ever-jobs/common';
import {
  SIMPLYHIRED_SEARCH_URL,
  SIMPLYHIRED_HEADERS,
  SIMPLYHIRED_DELAY_MIN,
  SIMPLYHIRED_DELAY_MAX,
} from './simplyhired.constants';

@SourcePlugin({
  site: Site.SIMPLYHIRED,
  name: 'SimplyHired',
  category: 'job-board',
})
@Injectable()
export class SimplyHiredService implements IScraper, OnModuleDestroy {
  private readonly logger = new Logger(SimplyHiredService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const resultsWanted = input.resultsWanted ?? 15;

    // Try cheerio first
    const cheerioJobs = await this.scrapeWithCheerio(input, resultsWanted);
    if (cheerioJobs.length > 0) {
      return new JobResponseDto(cheerioJobs);
    }

    // Fallback to Playwright if cheerio failed (likely anti-bot block)
    this.logger.log('SimplyHired: cheerio returned zero results, falling back to Playwright');
    const playwrightJobs = await this.scrapeWithPlaywright(input, resultsWanted);
    return new JobResponseDto(playwrightJobs);
  }

  private async scrapeWithCheerio(
    input: ScraperInputDto,
    resultsWanted: number,
  ): Promise<JobPostDto[]> {
    const client = createHttpClient(input);
    client.setHeaders(SIMPLYHIRED_HEADERS);

    const allJobs: JobPostDto[] = [];
    let page = 1;
    const maxPages = Math.ceil(resultsWanted / 20) + 1;

    while (allJobs.length < resultsWanted && page <= maxPages) {
      try {
        const url = new URL(SIMPLYHIRED_SEARCH_URL);
        if (input.searchTerm) url.searchParams.set('q', input.searchTerm);
        if (input.location) url.searchParams.set('l', input.location);
        if (page > 1) url.searchParams.set('pn', String(page));

        this.logger.log(`Fetching SimplyHired search page ${page}`);
        const response = await client.get<string>(url.toString());
        const html = response.data;

        const jobs = await this.enrichJobDetails(
          client,
          this.parseHtml(html),
          input.descriptionFormat,
        );
        if (jobs.length === 0) break;

        allJobs.push(...jobs);
        page++;

        if (page <= maxPages && allJobs.length < resultsWanted) {
          await randomSleep(SIMPLYHIRED_DELAY_MIN, SIMPLYHIRED_DELAY_MAX);
        }
      } catch (err: any) {
        this.logger.error(`SimplyHired cheerio error page ${page}: ${err.message}`);
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
      page = await BrowserPool.getPage({ proxy });
      const timeoutMs = (input.requestTimeout ?? 30) * 1000;

      const url = new URL(SIMPLYHIRED_SEARCH_URL);
      if (input.searchTerm) url.searchParams.set('q', input.searchTerm);
      if (input.location) url.searchParams.set('l', input.location);

      this.logger.log(`SimplyHired Playwright: navigating to ${url.toString()}`);
      await page.goto(url.toString(), {
        waitUntil: 'domcontentloaded',
        timeout: timeoutMs,
      });

      await this.delay(5000);

      const html = await page.content();
      const client = createHttpClient(input);
      client.setHeaders(SIMPLYHIRED_HEADERS);
      const jobs = await this.enrichJobDetails(
        client,
        this.parseHtml(html),
        input.descriptionFormat,
      );

      if (jobs.length === 0) {
        // TODO: Validate selectors against live SimplyHired rendered DOM
        this.logger.warn('SimplyHired Playwright: zero jobs extracted — selectors may need updating');
      }

      this.logger.log(`SimplyHired Playwright: extracted ${jobs.length} jobs`);
      return jobs.slice(0, resultsWanted);
    } catch (err: any) {
      this.logger.error(`SimplyHired Playwright scrape failed: ${err.message}`);
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

    // TODO: Validate selectors against live site
    const selectors = [
      '[data-testid="searchSerpJob"]',
      '.SerpJob',
      'article.SerpJob-jobCard',
      'li[data-jobkey]',
      '.jobposting-subtitle',
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
      cards = $('article, [data-job-id]');
    }

    if (!cards || cards.length === 0) {
      return [];
    }

    cards.each((_, el) => {
      try {
        const card = $(el);

        const titleEl = card.find('h2 a, h3 a, .jobposting-title a, a[data-testid="searchSerpJobTitle"]').first();
        const title = titleEl.text().trim();
        if (!title) return;

        let href = titleEl.attr('href') ?? '';
        if (!href) return;
        if (href.startsWith('/')) {
          href = `https://www.simplyhired.com${href}`;
        }

        const company = card.find('[data-testid="companyName"], .jobposting-company, .SerpJob-link--company').text().trim() || null;
        const location = card.find('[data-testid="searchSerpJobLocation"], .jobposting-location, .SerpJob-location').text().trim() || null;
        const salaryText = card.find('[data-testid="searchSerpJobSalaryEst"], .jobposting-salary, .SerpJob-salary').text().trim() || null;
        const snippet = this.usefulDescription(
          card.find('.jobposting-snippet, .SerpJob-snippet, p').first().text().trim(),
        );

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

        const id = `simplyhired-${Math.abs(this.hashCode(href))}`;

        jobs.push(new JobPostDto({
          id,
          title,
          companyName: company,
          jobUrl: href,
          location: location ? new LocationDto({ city: location }) : null,
          description: snippet,
          compensation: compensation as any,
          site: Site.SIMPLYHIRED,
        }));
      } catch {
        // Skip card errors
      }
    });

    return jobs;
  }

  private async enrichJobDetails(
    client: ReturnType<typeof createHttpClient>,
    jobs: JobPostDto[],
    format: DescriptionFormat | undefined,
  ): Promise<JobPostDto[]> {
    const enriched: JobPostDto[] = [];

    for (const job of jobs) {
      try {
        const response = await client.get<string>(job.jobUrl);
        const detail = this.parseDetailHtml(response.data ?? '', format);
        enriched.push(new JobPostDto({
          ...job,
          title: detail.title ?? job.title,
          companyName: detail.companyName ?? job.companyName,
          location: detail.location ?? job.location,
          description: detail.description ?? job.description ?? null,
          compensation: detail.compensation ?? job.compensation ?? null,
          datePosted: detail.datePosted ?? job.datePosted ?? null,
          employmentType: detail.employmentType ?? job.employmentType ?? null,
          jobType: detail.jobType ?? job.jobType ?? null,
          skills: detail.skills ?? job.skills ?? null,
          isRemote: detail.isRemote ?? job.isRemote ?? null,
          applyUrl: detail.applyUrl ?? job.applyUrl ?? job.jobUrl,
          companyLogo: detail.companyLogo ?? job.companyLogo ?? null,
          emails: extractEmails(detail.description ?? job.description ?? ''),
        }));
      } catch (err: any) {
        this.logger.warn(`SimplyHired detail fetch failed for ${job.jobUrl}: ${err.message}`);
        enriched.push(job);
      }
    }

    return enriched;
  }

  private parseDetailHtml(
    html: string,
    format: DescriptionFormat | undefined,
  ): Partial<JobPostDto> {
    const $ = cheerio.load(html);
    const posting = parseJobPostingLd(html)[0] ?? null;
    const main = this.mainJobHtml($);
    const mainText = this.cleanText(htmlToPlainText(main || $('body').html() || html));

    const descriptionRaw =
      posting?.description ??
      this.extractFullDescriptionHtml($) ??
      this.extractFullDescriptionText(mainText);
    const description = this.formatDescription(descriptionRaw, format);

    const compensation =
      jobPostingLdToCompensation(posting?.baseSalary) ??
      this.compensationFromText(mainText);

    const employmentType =
      posting?.employmentType ??
      this.firstMatchingLine(mainText, /\b(full[- ]?time|part[- ]?time|contract|temporary|internship)\b/i);
    const jobType = employmentType
      ? [getJobTypeFromString(employmentType)].filter((t): t is NonNullable<typeof t> => !!t)
      : null;

    const skills = this.extractChips($, 'Qualifications');
    const location = this.locationFromPosting(posting) ?? this.locationFromText(mainText);

    return {
      title: posting?.title ?? ($('h1').first().text().trim() || undefined),
      companyName: posting?.hiringOrganizationName ?? this.companyFromText(mainText),
      location,
      description,
      compensation,
      datePosted: posting?.datePosted ?? null,
      employmentType,
      jobType: jobType && jobType.length > 0 ? jobType : null,
      skills: skills.length > 0 ? skills : null,
      isRemote: posting?.remote ?? /\bremote\b/i.test(mainText),
      applyUrl: posting?.applyUrl ?? posting?.url ?? null,
      companyUrl: posting?.hiringOrganizationUrl ?? null,
    };
  }

  private mainJobHtml($: cheerio.CheerioAPI): string {
    $('aside, nav, header, footer, script, style').remove();
    $('[aria-label], [class], [data-testid]').each((_, el) => {
      const node = $(el);
      const marker = [
        node.attr('aria-label'),
        node.attr('class'),
        node.attr('data-testid'),
      ].join(' ').toLowerCase();
      if (marker.includes('similar')) node.remove();
    });

    const bodyHtml = $('body').html() ?? '';
    const cut = bodyHtml.search(/Our Most Similar Jobs|View more similar jobs|latest job alert/i);
    return cut >= 0 ? bodyHtml.slice(0, cut) : bodyHtml;
  }

  private extractFullDescriptionHtml($: cheerio.CheerioAPI): string | null {
    const headings = $('h2, h3, h4')
      .filter((_, el) => /full job description|position description|job description/i.test($(el).text()))
      .toArray();
    const heading = headings[0];
    if (!heading) return null;

    const parts: string[] = [];
    let node = $(heading).next();
    while (node.length > 0) {
      if (/^(h2|h3|h4)$/i.test((node.get(0) as any)?.name ?? '')) break;
      const html = node.html();
      if (html) parts.push(html);
      node = node.next();
    }
    return parts.length > 0 ? parts.join('\n') : null;
  }

  private extractFullDescriptionText(text: string): string | null {
    const match = text.match(/(?:Full Job Description|Position Description|Job Description)\s*([\s\S]+)/i);
    if (!match?.[1]) return null;
    return this.cleanText(match[1].replace(/Our Most Similar Jobs[\s\S]*$/i, ''));
  }

  private formatDescription(
    raw: string | null | undefined,
    format: DescriptionFormat | undefined,
  ): string | null {
    const useful = this.usefulDescription(raw);
    if (!useful) return null;
    if (format === DescriptionFormat.HTML) return raw ?? null;
    if (/<[a-z][\s\S]*>/i.test(useful)) {
      return format === DescriptionFormat.MARKDOWN
        ? markdownConverter(useful) ?? htmlToPlainText(useful)
        : htmlToPlainText(useful);
    }
    return useful;
  }

  private extractChips($: cheerio.CheerioAPI, heading: string): string[] {
    const head = $('h2, h3, h4')
      .filter((_, el) => $(el).text().trim().toLowerCase() === heading.toLowerCase())
      .first();
    if (!head.length) return [];

    const section = head.nextUntil('h2, h3, h4');
    const values = new Set<string>();
    section.each((_, el) => {
      const text = this.cleanText($(el).text());
      if (text && text.length <= 80) values.add(text);
    });
    section.find('li, span').each((_, el) => {
      const text = this.cleanText($(el).text());
      if (text && text.length <= 80) values.add(text);
    });
    return [...values];
  }

  private compensationFromText(text: string): JobPostDto['compensation'] {
    const line = this.firstMatchingLine(text, /([$€£]\s?\d|salary|an hour|a year|per hour|per year)/i);
    if (!line) return null;
    const parsed = extractSalary(line);
    if (parsed.minAmount == null && parsed.maxAmount == null) return null;
    return {
      interval: parsed.interval,
      minAmount: parsed.minAmount,
      maxAmount: parsed.maxAmount,
      currency: parsed.currency ?? 'USD',
    } as any;
  }

  private locationFromPosting(posting: ReturnType<typeof parseJobPostingLd>[number] | null): LocationDto | null {
    const loc = posting?.locations?.[0];
    if (!loc) return null;
    return new LocationDto({
      city: loc.city,
      state: loc.region,
      country: loc.country,
    });
  }

  private locationFromText(text: string): LocationDto | null {
    const line = this.firstMatchingLine(text, /\b[A-Z][a-zA-Z .'-]+,\s?[A-Z]{2}\b/);
    if (!line) return null;
    const match = line.match(/\b([A-Z][a-zA-Z .'-]+),\s?([A-Z]{2})\b/);
    if (!match) return null;
    return new LocationDto({ city: match[1].trim(), state: match[2].trim() });
  }

  private companyFromText(text: string): string | null {
    const lines = text.split('\n').map((l) => this.cleanText(l)).filter(Boolean);
    return lines.find((line) => line.length > 2 && line.length < 90 && !/job details|benefits|qualifications/i.test(line)) ?? null;
  }

  private firstMatchingLine(text: string, pattern: RegExp): string | null {
    return text
      .split('\n')
      .map((line) => this.cleanText(line))
      .find((line) => pattern.test(line)) ?? null;
  }

  private usefulDescription(value: string | null | undefined): string | null {
    const text = this.cleanText(value ?? '');
    if (!text) return null;
    if (/\.css-[a-z0-9_-]+|--chakra-|white-space\s*:|margin-right\s*:/i.test(text)) return null;
    if (text.length < 80) return null;
    return text;
  }

  private cleanText(value: string): string {
    return value
      .replace(/\r/g, '\n')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
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
