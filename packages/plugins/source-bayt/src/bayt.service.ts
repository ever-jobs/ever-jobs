import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import * as cheerio from 'cheerio';
import {
  classifyScrapeError,
  ScrapeDiagnostics,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto,
  LocationDto, Country, Site, countryFromString,
} from '@ever-jobs/models';
import { createHttpClient, randomSleep } from '@ever-jobs/common';

@SourcePlugin({
  site: Site.BAYT,
  name: 'Bayt',
  category: 'regional',
})
@Injectable()
export class BaytService implements IScraper {
  private readonly logger = new Logger(BaytService.name);
  private readonly baseUrl = 'https://www.bayt.com';
  private readonly delay = 2;
  private readonly bandDelay = 3;

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });

    const jobList: JobPostDto[] = [];
    let diagnostics: ScrapeDiagnostics | undefined;
    const resultsWanted = input.resultsWanted ?? 10;
    let page = 1;

    while (jobList.length < resultsWanted) {
      this.logger.log(`Fetching Bayt jobs page ${page}`);

      try {
        const searchTerm = (input.searchTerm ?? '').replace(/\s+/g, '-');
        const url = `${this.baseUrl}/en/international/jobs/${searchTerm}-jobs/?page=${page}`;
        const response = await client.get(url);

        const $ = cheerio.load(response.data);
        const jobCards = $('li[data-js-job]');

        if (jobCards.length === 0) {
          this.logger.log('No more Bayt job results');
          break;
        }

        let newJobs = false;
        jobCards.each((_, el) => {
          if (jobList.length >= resultsWanted) return;
          try {
            const card = $(el);
            const jobPost = this.extractJob($, card);
            if (jobPost) {
              jobList.push(jobPost);
              newJobs = true;
            }
          } catch (err: any) {
            this.logger.warn(`Bayt extract error: ${err.message}`);
          }
        });

        if (!newJobs) break;
        page++;
        await randomSleep(this.delay * 1000, (this.delay + this.bandDelay) * 1000);
      } catch (err: any) {
        this.logger.error(`Bayt scrape error: ${err.message}`);
        break;
        diagnostics = classifyScrapeError(err);
      }
    }

    return new JobResponseDto(jobList.slice(0, resultsWanted), diagnostics);
  }

  private extractJob($: cheerio.CheerioAPI, card: cheerio.Cheerio<any>): JobPostDto | null {
    const h2 = card.find('h2');
    if (!h2.length) return null;

    const title = h2.text().trim();
    const a = h2.find('a');
    const href = a.attr('href');
    if (!href) return null;
    const jobUrl = `${this.baseUrl}${href.trim()}`;

    // Company
    const companyDiv = card.find('div.t-nowrap.p10l');
    const companyName = companyDiv.find('span').first().text().trim() || null;

    // Location
    const locationDiv = card.find('div.t-mute.t-small');
    const locationText = locationDiv.text().trim() || null;

    const jobId = `bayt-${Math.abs(this.hashCode(jobUrl))}`;
    const location = new LocationDto({
      city: locationText,
      country: Country.WORLDWIDE,
    });

    return new JobPostDto({
      id: jobId,
      title,
      companyName,
      location,
      jobUrl,
      site: Site.BAYT,
    });
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
