import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import * as cheerio from 'cheerio';
import {
  classifyScrapeError,
  ScrapeDiagnostics,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto,
  LocationDto, DescriptionFormat, Site,
} from '@ever-jobs/models';
import { createHttpClient, markdownConverter, plainConverter, randomSleep } from '@ever-jobs/common';

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

    const jobList: JobPostDto[] = [];
    let diagnostics: ScrapeDiagnostics | undefined;
    const resultsWanted = input.resultsWanted ?? 15;
    const searchTerm = input.googleSearchTerm ?? input.searchTerm ?? '';
    const query = this.buildQuery(searchTerm, input);

    this.logger.log(`Fetching Google Jobs for: "${query}"`);

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

      while (jobList.length < resultsWanted && retries < maxRetries) {
        await randomSleep(this.delay * 1000, (this.delay + this.bandDelay) * 1000);
        client.setHeaders(GOOGLE_HEADERS_NEXT);

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
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash |= 0;
    }
    return hash;
  }
}
