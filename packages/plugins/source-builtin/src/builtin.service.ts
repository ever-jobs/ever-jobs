import { SourcePlugin } from '@ever-jobs/plugin';

/**
 * BuiltIn.com Job Search — tech-focused job board.
 *
 * Strategy:
 *  1. Primary: REST search endpoint with JSON response
 *  2. Fallback: HTML scraping of search results page with __NEXT_DATA__ extraction
 */
import { Injectable, Logger } from '@nestjs/common';
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
  stripHtmlTags,
} from '@ever-jobs/common';
import {
  BUILTIN_BASE_URL,
  BUILTIN_HEADERS,
  BUILTIN_DELAY_MIN,
  BUILTIN_DELAY_MAX,
  BUILTIN_PAGE_SIZE,
  BUILTIN_LOCATIONS,
  BUILTIN_JOB_TYPES,
} from './builtin.constants';
import type { BuiltInJob, BuiltInSearchResponse, BuiltInPageData } from './builtin.types';

@SourcePlugin({
  site: Site.BUILTIN,
  name: 'BuiltIn',
  category: 'niche',
})
@Injectable()
export class BuiltInService implements IScraper {
  private readonly logger = new Logger(BuiltInService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const resultsWanted = input.resultsWanted ?? 15;
    // The API failure is a ROUTING SIGNAL, not an outcome - the HTML fallback
    // decides the result. Only surface it if that fallback also yields nothing.
    let apiFailure: ScrapeDiagnostics | undefined;

    // Primary: REST API search
    try {
      const apiJobs = await this.scrapeApi(input, resultsWanted);
      if (apiJobs.length > 0) {
        return new JobResponseDto(apiJobs);
      }
      this.logger.log('BuiltIn API returned zero results, trying HTML fallback');
    } catch (err: any) {
      this.logger.warn(`BuiltIn API failed: ${err.message}, trying HTML fallback`);
      apiFailure = classifyScrapeError(err);
    }

    // Fallback: HTML scraping
    const htmlJobs = await this.scrapeHtml(input, resultsWanted);
    return new JobResponseDto(htmlJobs, htmlJobs.length ? undefined : apiFailure);
  }

  // ── Primary: REST API ────────────────────────────────────────────────

  private async scrapeApi(
    input: ScraperInputDto,
    resultsWanted: number,
  ): Promise<JobPostDto[]> {
    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(BUILTIN_HEADERS);

    const allJobs: JobPostDto[] = [];
    let page = 0;
    const maxPages = Math.ceil(resultsWanted / BUILTIN_PAGE_SIZE) + 1;

    while (allJobs.length < resultsWanted && page < maxPages) {
      try {
        // Build the search URL
        const locationSlug = this.resolveLocation(input.location);
        const basePath = locationSlug ? `/jobs/${locationSlug}` : '/jobs';
        const url = new URL(`${BUILTIN_BASE_URL}${basePath}`);

        if (input.searchTerm) url.searchParams.set('search', input.searchTerm);
        if (page > 0) url.searchParams.set('page', String(page));

        this.logger.log(`Fetching BuiltIn page ${page + 1}: ${url.toString()}`);

        // BuiltIn returns HTML but embeds __NEXT_DATA__ JSON
        const response = await client.get<string>(url.toString());
        const html = response.data;

        // Try to extract __NEXT_DATA__ JSON
        const jobs = this.extractFromNextData(html);
        if (jobs.length === 0) {
          // Fallback to HTML parsing
          const htmlJobs = this.parseHtmlCards(html);
          if (htmlJobs.length === 0) break;
          allJobs.push(...htmlJobs);
        } else {
          allJobs.push(...jobs);
        }

        page++;
        if (page < maxPages && allJobs.length < resultsWanted) {
          await randomSleep(BUILTIN_DELAY_MIN, BUILTIN_DELAY_MAX);
        }
      } catch (err: any) {
        this.logger.error(`BuiltIn API error page ${page + 1}: ${err.message}`);
        break;
      }
    }

    return allJobs.slice(0, resultsWanted);
  }

  // ── Fallback: HTML Scraping ──────────────────────────────────────────

  private async scrapeHtml(
    input: ScraperInputDto,
    resultsWanted: number,
  ): Promise<JobPostDto[]> {
    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders({
      ...BUILTIN_HEADERS,
      Accept: 'text/html,application/xhtml+xml',
    });

    try {
      const locationSlug = this.resolveLocation(input.location);
      const basePath = locationSlug ? `/jobs/${locationSlug}` : '/jobs';
      const url = new URL(`${BUILTIN_BASE_URL}${basePath}`);
      if (input.searchTerm) url.searchParams.set('search', input.searchTerm);

      this.logger.log(`Fetching BuiltIn HTML: ${url.toString()}`);
      const response = await client.get<string>(url.toString());
      const jobs = this.parseHtmlCards(response.data);
      return jobs.slice(0, resultsWanted);
    } catch (err: any) {
      this.logger.error(`BuiltIn HTML scrape failed: ${err.message}`);
      return [];
    }
  }

  // ── Data extraction ──────────────────────────────────────────────────

  /** Extract jobs from __NEXT_DATA__ JSON embedded in the HTML */
  private extractFromNextData(html: string): JobPostDto[] {
    try {
      const $ = cheerio.load(html);
      const scriptTag = $('script#__NEXT_DATA__').html();
      if (!scriptTag) return [];

      const data: BuiltInPageData = JSON.parse(scriptTag);
      const rawJobs = data?.props?.pageProps?.jobs ?? [];

      return rawJobs
        .map((job) => this.processJob(job))
        .filter(Boolean) as JobPostDto[];
    } catch {
      return [];
    }
  }

  /** Parse HTML job cards using cheerio selectors */
  private parseHtmlCards(html: string): JobPostDto[] {
    const $ = cheerio.load(html);
    const jobs: JobPostDto[] = [];

    // BuiltIn uses various card selectors
    const selectors = [
      '[data-id="job-card"]',
      '.job-card',
      '[class*="JobCard"]',
      'article[class*="job"]',
      'div[class*="job-listing"]',
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

        const titleEl = card.find('h2 a, h3 a, [data-id="job-title"] a, a[class*="title"]').first();
        const title = titleEl.text().trim();
        if (!title) return;

        let href = titleEl.attr('href') ?? '';
        if (!href) return;
        if (href.startsWith('/')) href = `${BUILTIN_BASE_URL}${href}`;

        const company = card.find('[data-id="company-title"], [class*="company-name"], span[class*="Company"]').text().trim() || null;
        const location = card.find('[data-id="job-location"], [class*="location"]').text().trim() || null;
        const salary = card.find('[data-id="job-salary"], [class*="salary"]').text().trim() || null;
        const snippet = card.find('[data-id="job-description"], p, [class*="description"]').first().text().trim() || null;

        let compensation = null;
        if (salary) {
          const match = salary.match(/\$?([\d,]+)k?\s*[-–]\s*\$?([\d,]+)k?/i);
          if (match) {
            let min = parseInt(match[1].replace(/,/g, ''), 10);
            let max = parseInt(match[2].replace(/,/g, ''), 10);
            // BuiltIn often shows salary in K format
            if (min < 1000) min *= 1000;
            if (max < 1000) max *= 1000;
            compensation = new CompensationDto({
              interval: CompensationInterval.YEARLY,
              minAmount: min,
              maxAmount: max,
              currency: 'USD',
            });
          }
        }

        const isRemote = (location?.toLowerCase().includes('remote') ?? false) ||
          card.find('[class*="remote"]').length > 0;

        const id = `builtin-${Math.abs(this.hashCode(href))}`;

        jobs.push(new JobPostDto({
          id,
          title,
          companyName: company,
          jobUrl: href,
          location: location ? new LocationDto({ city: location }) : null,
          description: snippet,
          compensation: compensation as any,
          isRemote,
          site: Site.BUILTIN,
        }));
      } catch {
        // Skip card errors
      }
    });

    return jobs;
  }

  /** Convert a BuiltIn API job to a JobPostDto */
  private processJob(job: BuiltInJob): JobPostDto | null {
    try {
      if (!job.title) return null;

      // Build URL
      let jobUrl = '';
      if (job.url) {
        jobUrl = job.url.startsWith('http') ? job.url : `${BUILTIN_BASE_URL}${job.url}`;
      } else if (job.alias) {
        jobUrl = `${BUILTIN_BASE_URL}/job/${job.alias}`;
      } else {
        jobUrl = `${BUILTIN_BASE_URL}/job/internal/${job.id}`;
      }

      // Build location
      const locationParts = [job.city_name, job.state_name].filter(Boolean);
      const locationStr = locationParts.length > 0 ? locationParts.join(', ') : null;
      const location = locationStr
        ? new LocationDto({
            city: job.city_name ?? null,
            state: job.state_name ?? null,
            country: job.country_name ?? 'US',
          })
        : null;

      // Remote check
      const isRemote =
        job.remote_type === 'Remote' ||
        job.remote_type === 'Fully Remote' ||
        locationStr?.toLowerCase().includes('remote') ||
        false;

      // Compensation
      let compensation = null;
      if (job.salary_min || job.salary_max) {
        compensation = new CompensationDto({
          interval: job.salary_type === 'Hourly' ? CompensationInterval.HOURLY : CompensationInterval.YEARLY,
          minAmount: job.salary_min ?? null,
          maxAmount: job.salary_max ?? null,
          currency: 'USD',
        });
      }

      // Job type
      const jobType = job.job_type && BUILTIN_JOB_TYPES[job.job_type]
        ? [BUILTIN_JOB_TYPES[job.job_type] as JobType]
        : job.job_type
          ? [job.job_type.toLowerCase() as JobType]
          : null;

      // Description
      const description = job.body_teaser
        ? stripHtmlTags(job.body_teaser).slice(0, 500)
        : job.body
          ? stripHtmlTags(job.body).slice(0, 500)
          : null;

      return new JobPostDto({
        id: `builtin-${job.id}`,
        title: job.title,
        companyName: job.company_name ?? null,
        companyUrl: job.company_alias
          ? `${BUILTIN_BASE_URL}/company/${job.company_alias}`
          : null,
        jobUrl,
        location,
        description,
        compensation: compensation as any,
        datePosted: job.created ?? job.changed ?? null,
        isRemote,
        jobType,
        department: job.department ?? null,
        site: Site.BUILTIN,
      });
    } catch {
      return null;
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────

  /** Resolve a location string to a BuiltIn location slug */
  private resolveLocation(location?: string): string | null {
    if (!location) return null;
    const lower = location.toLowerCase().trim();

    // Check direct match
    if (BUILTIN_LOCATIONS[lower]) return BUILTIN_LOCATIONS[lower];

    // Check partial match
    for (const [key, slug] of Object.entries(BUILTIN_LOCATIONS)) {
      if (lower.includes(key) || key.includes(lower)) return slug;
    }

    // Return null for unrecognized locations (will search nationally)
    return null;
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
