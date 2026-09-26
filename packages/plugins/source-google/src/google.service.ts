import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import * as cheerio from 'cheerio';
import {
  classifyScrapeError,
  looksLikeChallenge,
  ScrapeDiagnostics,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto,
  LocationDto, DescriptionFormat, Site,
} from '@ever-jobs/models';
import { createHttpClient, HttpClient, markdownConverter, plainConverter, randomSleep } from '@ever-jobs/common';
import {
  GOOGLE_CURSOR_NO_RECORDS_DETAIL,
  GOOGLE_INTERSTITIAL_DETAIL,
  GOOGLE_SEARCH_URL,
  GOOGLE_ZERO_YIELD_DETAIL,
  googleLegacyParserEnabled,
  googleMaxPages,
} from './google.constants';
import {
  extractGoogleCursor,
  googleHashCode,
  looksLikeGoogleInterstitial,
  parseGoogleJobRecords,
} from './google.parser';

const GOOGLE_HEADERS_INITIAL: Record<string, string> = {
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9',
  'accept-language': 'en-US,en;q=0.9',
  'user-agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
};

const GOOGLE_HEADERS_NEXT: Record<string, string> = {
  accept: '*/*',
  'accept-language': 'en-US,en;q=0.5',
  'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
  'user-agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
};

/** What a response (or an error's response) says about the page it carried. */
interface GooglePage {
  html: string;
  status?: number;
  finalUrl?: string;
}

function bodyText(data: unknown): string {
  if (typeof data === 'string') return data;
  if (data == null) return '';
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  try {
    return JSON.stringify(data) ?? '';
  } catch {
    return '';
  }
}

function pageOf(resp: unknown): GooglePage {
  const r = resp as
    | {
        data?: unknown;
        status?: unknown;
        request?: { res?: { responseUrl?: unknown }; responseURL?: unknown };
      }
    | null
    | undefined;
  const finalUrl = [r?.request?.res?.responseUrl, r?.request?.responseURL].find(
    (u): u is string => typeof u === 'string' && u.length > 0,
  );
  return {
    html: bodyText(r?.data),
    status: typeof r?.status === 'number' ? r.status : undefined,
    finalUrl,
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

@SourcePlugin({
  site: Site.GOOGLE,
  name: 'Google Jobs',
  category: 'job-board',
})
@Injectable()
export class GoogleService implements IScraper {
  private readonly logger = new Logger(GoogleService.name);
  private readonly delay = 3;
  private readonly bandDelay = 3;

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const client = createHttpClient(input);

    const resultsWanted = input.resultsWanted ?? 15;
    const searchTerm = input.googleSearchTerm ?? input.searchTerm ?? '';
    const query = this.buildQuery(searchTerm, input);
    const maxPages = googleMaxPages();

    this.logger.log(`Fetching Google Jobs for: "${query}"`);

    if (googleLegacyParserEnabled()) {
      return this.scrapeLegacy(client, query, input, resultsWanted, maxPages);
    }
    return this.scrapeRecords(client, query, resultsWanted, maxPages);
  }

  /**
   * Spec 1704 read path. Every row comes from one inline job record, so its
   * title, company, URL, id and location belong together. The follow-up loop
   * runs only when the first page carries a forward cursor, and a page that
   * yields nothing says why instead of returning a silent `[]`.
   */
  private async scrapeRecords(
    client: HttpClient,
    query: string,
    resultsWanted: number,
    maxPages: number,
  ): Promise<JobResponseDto> {
    const jobList: JobPostDto[] = [];
    const seen = new Set<string>();
    const warnedKeys = new Set<string>();
    let diagnostics: ScrapeDiagnostics | undefined;
    let first: GooglePage = { html: '' };
    let cursor: string | null = null;

    try {
      client.setHeaders(GOOGLE_HEADERS_INITIAL);
      const initialResp = await client.get(GOOGLE_SEARCH_URL, {
        params: { q: query, ibp: 'htl;jobs', hl: 'en' },
      });
      first = pageOf(initialResp);
      this.collectRecords(first.html, jobList, seen, resultsWanted, warnedKeys);
      cursor = extractGoogleCursor(first.html);
    } catch (err) {
      this.logger.error(`Google Jobs scrape error: ${errorMessage(err)}`);
      return new JobResponseDto([], this.classifyGoogleError(err));
    }

    if (cursor) {
      diagnostics = await this.paginateRecords(client, query, jobList, seen, resultsWanted, maxPages, warnedKeys);
    } else if (jobList.length < resultsWanted) {
      this.logger.debug('No forward cursor on the first Google page; not paginating');
    }

    if (jobList.length === 0 && !diagnostics) {
      diagnostics = this.zeroYieldDiagnostics(first, cursor !== null);
    }
    return new JobResponseDto(jobList, diagnostics);
  }

  /**
   * The pre-Spec-1704 pagination loop, unchanged in what it requests, now
   * reading records, deduping by id across pages, stopping on a page with no
   * new rows, and capped at `maxPages` requests. Returns a diagnostic when the
   * loop gave up on errors.
   */
  private async paginateRecords(
    client: HttpClient,
    query: string,
    jobList: JobPostDto[],
    seen: Set<string>,
    resultsWanted: number,
    maxPages: number,
    warnedKeys: Set<string>,
  ): Promise<ScrapeDiagnostics | undefined> {
    let asyncStart = 10;
    let retries = 0;
    const maxRetries = 3;
    let pages = 0;
    let lastError: unknown;

    while (jobList.length < resultsWanted && retries < maxRetries && pages < maxPages) {
      await randomSleep(this.delay * 1000, (this.delay + this.bandDelay) * 1000);
      client.setHeaders(GOOGLE_HEADERS_NEXT);
      pages++;

      try {
        const nextResp = await client.get(GOOGLE_SEARCH_URL, {
          params: {
            q: query,
            ibp: 'htl;jobs',
            hl: 'en',
            start: asyncStart,
            asearch: 'jbs',
            async: `_id:VoQFxe,_pms:hts,_fmt:pc`,
          },
        });

        const added = this.collectRecords(pageOf(nextResp).html, jobList, seen, resultsWanted, warnedKeys);
        if (added === 0) break;

        asyncStart += 10;
      } catch (err) {
        lastError = err;
        retries++;
        this.logger.warn(`Google pagination retry ${retries}/${maxRetries}`);
      }
    }

    if (pages >= maxPages && jobList.length < resultsWanted) {
      this.logger.debug(`Google pagination stopped at the ${maxPages}-page cap`);
    }
    if (retries < maxRetries) return undefined;

    const cause = this.classifyGoogleError(lastError);
    if (jobList.length === 0) return cause;
    const detail = `pagination stopped after ${maxRetries} failed page requests (${cause.reason}${
      cause.detail ? `: ${cause.detail}` : ''
    })`;
    return new ScrapeDiagnostics('partial', detail.slice(0, 300));
  }

  /** Append this page's new rows; returns how many were added. */
  private collectRecords(
    text: string,
    jobList: JobPostDto[],
    seen: Set<string>,
    resultsWanted: number,
    warnedKeys: Set<string>,
  ): number {
    const page = parseGoogleJobRecords(text);
    if (page.viaFallback) {
      const fresh = page.keys.filter((key) => !warnedKeys.has(key));
      if (fresh.length > 0) {
        for (const key of fresh) warnedKeys.add(key);
        this.logger.warn(
          `Google job records found under unlisted payload key(s) ${fresh.join(', ')}; add to GOOGLE_JOB_PAYLOAD_KEYS`,
        );
      }
    }

    let added = 0;
    for (const job of page.jobs) {
      if (jobList.length >= resultsWanted) break;
      if (!job.id || seen.has(job.id)) continue;
      seen.add(job.id);
      jobList.push(job);
      added++;
    }
    return added;
  }

  /** A first page with no rows is a block or an unreadable page, never "empty". */
  private zeroYieldDiagnostics(first: GooglePage, cursorFound: boolean): ScrapeDiagnostics {
    if (looksLikeChallenge(first.html) || looksLikeGoogleInterstitial(first.html, first.finalUrl, first.status)) {
      return new ScrapeDiagnostics('blocked', GOOGLE_INTERSTITIAL_DETAIL);
    }
    return new ScrapeDiagnostics('unknown', cursorFound ? GOOGLE_CURSOR_NO_RECORDS_DETAIL : GOOGLE_ZERO_YIELD_DETAIL);
  }

  /**
   * `classifyScrapeError`, except that an error whose response is one of
   * Google's interstitials (a 429 `/sorry/` page, "unusual traffic", the
   * JavaScript-required redirect) is `blocked` rather than `fetch_error`.
   */
  private classifyGoogleError(err: unknown): ScrapeDiagnostics {
    const base = classifyScrapeError(err);
    const response = (err as { response?: unknown } | null | undefined)?.response;
    if (!response) return base;
    const page = pageOf(response);
    if (looksLikeChallenge(page.html) || looksLikeGoogleInterstitial(page.html, page.finalUrl, page.status)) {
      return new ScrapeDiagnostics('blocked', base.detail ?? GOOGLE_INTERSTITIAL_DETAIL);
    }
    return base;
  }

  /**
   * The pre-Spec-1704 read path, selected by `EVER_JOBS_GOOGLE_LEGACY_PARSER`.
   * Kept byte-for-byte except for the `maxPages` cap on the loop. It pairs
   * titles with URLs by list position, so rows can be misattributed.
   */
  private async scrapeLegacy(
    client: HttpClient,
    query: string,
    input: ScraperInputDto,
    resultsWanted: number,
    maxPages: number,
  ): Promise<JobResponseDto> {
    const jobList: JobPostDto[] = [];
    let diagnostics: ScrapeDiagnostics | undefined;

    try {
      // Fetch initial page
      client.setHeaders(GOOGLE_HEADERS_INITIAL);
      const initialResp = await client.get('https://www.google.com/search', {
        params: { q: query, ibp: 'htl;jobs', hl: 'en' },
      });

      const $ = cheerio.load(initialResp.data);

      // Extract the initial set of jobs from embedded JSON
      const scriptTags = $('script').toArray();
      for (const script of scriptTags) {
        const content = $(script).html() ?? '';
        if (content.includes('AF_initDataCallback') && content.includes('job')) {
          const jobs = this.parseGoogleJobs(content, input.descriptionFormat);
          for (const job of jobs) {
            if (jobList.length >= resultsWanted) break;
            jobList.push(job);
          }
        }
      }

      // Try pagination via async requests
      let asyncStart = 10;
      let retries = 0;
      const maxRetries = 3;
      let pages = 0;

      while (jobList.length < resultsWanted && retries < maxRetries && pages < maxPages) {
        await randomSleep(this.delay * 1000, (this.delay + this.bandDelay) * 1000);
        client.setHeaders(GOOGLE_HEADERS_NEXT);
        pages++;

        try {
          const nextResp = await client.get('https://www.google.com/search', {
            params: {
              q: query,
              ibp: 'htl;jobs',
              hl: 'en',
              start: asyncStart,
              asearch: 'jbs',
              async: `_id:VoQFxe,_pms:hts,_fmt:pc`,
            },
          });

          const newJobs = this.parseGoogleJobs(nextResp.data, input.descriptionFormat);
          if (newJobs.length === 0) break;

          for (const job of newJobs) {
            if (jobList.length >= resultsWanted) break;
            jobList.push(job);
          }

          asyncStart += 10;
        } catch {
          retries++;
          this.logger.warn(`Google pagination retry ${retries}/${maxRetries}`);
        }
      }
    } catch (err: any) {
      this.logger.error(`Google Jobs scrape error: ${err.message}`);
      diagnostics = classifyScrapeError(err);
    }

    return new JobResponseDto(jobList, diagnostics);
  }

  private buildQuery(searchTerm: string, input: ScraperInputDto): string {
    let query = `${searchTerm} jobs`;
    if (input.location) query += ` near ${input.location}`;
    if (input.isRemote) query += ' remote';
    if (input.jobType) query += ` ${input.jobType}`;
    return query;
  }

  /**
   * Pre-Spec-1704 parser, reached only through {@link scrapeLegacy}. Collects
   * title/company pairs and URLs into two unrelated lists and zips them by
   * position, so a row can carry another job's URL.
   */
  private parseGoogleJobs(rawData: string, format?: DescriptionFormat): JobPostDto[] {
    const jobs: JobPostDto[] = [];

    // Extract JSON arrays from Google's AF_initDataCallback or inline data
    const jsonRegex = /\["(\w+)"(?:,\s*"[^"]*"){0,2}(?:,\s*"[^"]*")?,\s*"([^"]+)"/g;
    const titleRegex = /\[\s*"([^"]{5,100})"\s*,\s*"([^"]{2,80})"\s*,/g;

    let match;
    const titleCompanyPairs: { title: string; company: string }[] = [];
    while ((match = titleRegex.exec(rawData)) !== null) {
      if (
        !match[1].includes('http') &&
        !match[1].includes('function') &&
        match[1].length > 3 &&
        match[2].length > 1
      ) {
        titleCompanyPairs.push({ title: match[1], company: match[2] });
      }
    }

    // Extract job URLs
    const urlRegex = /(https?:\/\/[^\s"\\]+(?:careers|jobs|apply)[^\s"\\]*)/gi;
    const urls: string[] = [];
    while ((match = urlRegex.exec(rawData)) !== null) {
      urls.push(match[1]);
    }

    // Pair up title/company with URLs
    for (let i = 0; i < Math.min(titleCompanyPairs.length, 20); i++) {
      const { title, company } = titleCompanyPairs[i];
      const jobUrl = urls[i] ?? `https://www.google.com/search?q=${encodeURIComponent(title + ' ' + company + ' jobs')}`;
      const jobId = `go-${Math.abs(this.hashCode(jobUrl))}`;

      jobs.push(new JobPostDto({
        id: jobId,
        title,
        companyName: company,
        jobUrl,
        location: new LocationDto(),
        site: Site.GOOGLE,
      }));
    }

    return jobs;
  }

  private hashCode(str: string): number {
    return googleHashCode(str);
  }
}
