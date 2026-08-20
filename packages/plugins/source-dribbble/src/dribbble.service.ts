import { SourcePlugin } from '@ever-jobs/plugin';

/**
 * Dribbble Jobs — design-focused job board.
 *
 * Uses the Dribbble jobs board HTML with __NEXT_DATA__ extraction
 * and cheerio HTML fallback.
 */
import { Injectable, Logger } from '@nestjs/common';
import * as cheerio from 'cheerio';
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
import { createHttpClient, stripHtmlTags, extractSalary } from '@ever-jobs/common';

const DRIBBBLE_BASE_URL = 'https://dribbble.com';
const DRIBBBLE_JOBS_URL = 'https://dribbble.com/jobs';

const HEADERS: Record<string, string> = {
  Accept: 'text/html,application/xhtml+xml',
  'Accept-Language': 'en-US,en;q=0.9',
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
};

@SourcePlugin({
  site: Site.DRIBBBLE,
  name: 'Dribbble',
  category: 'niche',
})
@Injectable()
export class DribbbleService implements IScraper {
  private readonly logger = new Logger(DribbbleService.name);

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

    try {
      const url = new URL(DRIBBBLE_JOBS_URL);
      if (input.searchTerm) url.searchParams.set('keyword', input.searchTerm);
      if (input.location) url.searchParams.set('location', input.location);

      this.logger.log(`Fetching Dribbble Jobs: ${url.toString()}`);
      const response = await client.get<string>(url.toString());
      const html = response.data;

      // Try __NEXT_DATA__ extraction first
      const nextJobs = this.extractFromNextData(html);
      if (nextJobs.length > 0) {
        allJobs.push(...nextJobs);
      } else {
        // Fallback to HTML parsing
        const htmlJobs = this.parseHtml(html);
        allJobs.push(...htmlJobs);
      }
    } catch (err: any) {
      this.logger.error(`Dribbble Jobs scrape failed: ${err.message}`);
      diagnostics = classifyScrapeError(err);
    }

    return new JobResponseDto(allJobs.slice(0, resultsWanted), diagnostics);
  }

  private extractFromNextData(html: string): JobPostDto[] {
    try {
      const $ = cheerio.load(html);
      const script = $('script#__NEXT_DATA__').html();
      if (!script) return [];

      const data = JSON.parse(script);
      const jobs = data?.props?.pageProps?.jobs ?? data?.props?.pageProps?.data?.jobs ?? [];
      if (!Array.isArray(jobs) || jobs.length === 0) return [];

      return jobs.map((raw: any) => this.processApiJob(raw)).filter(Boolean) as JobPostDto[];
    } catch {
      return [];
    }
  }

  private processApiJob(raw: any): JobPostDto | null {
    try {
      const title = raw.title ?? raw.name;
      if (!title) return null;

      let jobUrl = raw.url ?? raw.slug ?? '';
      if (jobUrl && !jobUrl.startsWith('http')) {
        jobUrl = `${DRIBBBLE_BASE_URL}/jobs/${jobUrl}`;
      }

      const locationStr = raw.location ?? raw.city ?? null;
      const location = locationStr ? new LocationDto({ city: locationStr }) : null;
      const isRemote = raw.remote === true || raw.workplace_type === 'remote' ||
        locationStr?.toLowerCase().includes('remote') || false;

      let compensation = null;
      if (raw.salary_min || raw.salary_max) {
        compensation = new CompensationDto({
          interval: CompensationInterval.YEARLY,
          minAmount: raw.salary_min ?? null,
          maxAmount: raw.salary_max ?? null,
          currency: raw.salary_currency ?? 'USD',
        });
      }

      return new JobPostDto({
        id: `dribbble-${raw.id ?? Math.abs(this.hashCode(jobUrl))}`,
        title,
        companyName: raw.company_name ?? raw.company?.name ?? raw.team?.name ?? null,
        companyUrl: raw.company_url ?? null,
        jobUrl,
        location,
        description: raw.description ? stripHtmlTags(raw.description).slice(0, 500) : null,
        compensation: compensation as any,
        datePosted: raw.published_at ?? raw.created_at ?? null,
        isRemote,
        jobType: raw.employment_type ? [raw.employment_type.toLowerCase()] : null,
        site: Site.DRIBBBLE,
      });
    } catch {
      return null;
    }
  }

  private parseHtml(html: string): JobPostDto[] {
    const $ = cheerio.load(html);
    const jobs: JobPostDto[] = [];

    const selectors = [
      '.job-listing',
      '[class*="JobCard"]',
      'li[class*="job"]',
      'article[class*="job"]',
      '.jobs-list a, .job-board-list a',
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
        const titleEl = card.find('h2 a, h3 a, a[class*="title"]').first();
        const title = titleEl.text().trim() || card.find('a').first().text().trim();
        if (!title) return;

        let href = titleEl.attr('href') ?? card.find('a').first().attr('href') ?? '';
        if (!href) return;
        if (href.startsWith('/')) href = `${DRIBBBLE_BASE_URL}${href}`;

        const company = card.find('[class*="company"], .job-company').text().trim() || null;
        const location = card.find('[class*="location"], .job-location').text().trim() || null;
        const salary = card.find('[class*="salary"]').text().trim() || null;

        let compensation = null;
        if (salary) {
          const parsed = extractSalary(salary);
          if (parsed.minAmount != null) {
            compensation = new CompensationDto({
              interval: parsed.interval as any,
              minAmount: parsed.minAmount,
              maxAmount: parsed.maxAmount,
              currency: parsed.currency ?? 'USD',
            });
          }
        }

        const isRemote = location?.toLowerCase().includes('remote') ?? false;
        const id = `dribbble-${Math.abs(this.hashCode(href))}`;

        jobs.push(new JobPostDto({
          id,
          title,
          companyName: company,
          jobUrl: href,
          location: location ? new LocationDto({ city: location }) : null,
          compensation: compensation as any,
          isRemote,
          site: Site.DRIBBBLE,
        }));
      } catch {
        // Skip card errors
      }
    });

    return jobs;
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
