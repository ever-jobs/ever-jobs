import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import * as cheerio from 'cheerio';
import {
  classifyScrapeError,
  ScrapeDiagnostics,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto,
  LocationDto, Country, DescriptionFormat, Site, countryFromString,
} from '@ever-jobs/models';
import {
  createHttpClient, markdownConverter, removeAttributes,
  extractEmails, randomSleep, toDateOnly,
} from '@ever-jobs/common';
import { BDJOBS_HEADERS, BDJOBS_SEARCH_PARAMS, BDJOBS_JOB_SELECTORS } from './bdjobs.constants';

@SourcePlugin({
  site: Site.BDJOBS,
  name: 'BDJobs',
  category: 'regional',
})
@Injectable()
export class BDJobsService implements IScraper {
  private readonly logger = new Logger(BDJobsService.name);
  private readonly baseUrl = 'https://jobs.bdjobs.com';
  private readonly searchUrl = 'https://jobs.bdjobs.com/jobsearch.asp';
  private readonly delay = 2;
  private readonly bandDelay = 3;

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(BDJOBS_HEADERS);

    const jobList: JobPostDto[] = [];
    let diagnostics: ScrapeDiagnostics | undefined;
    const resultsWanted = input.resultsWanted ?? 15;
    const seenIds = new Set<string>();
    let page = 1;

    const params = { ...BDJOBS_SEARCH_PARAMS, txtsearch: input.searchTerm ?? '' };

    while (jobList.length < resultsWanted) {
      this.logger.log(`Fetching BDJobs page ${page}`);

      try {
        const reqParams: Record<string, any> = { ...params };
        if (page > 1) reqParams.pg = page;

        const response = await client.get(this.searchUrl, {
          params: reqParams,
          timeout: (input.requestTimeout ?? 60) * 1000,
        });

        if (response.status !== 200) {
          this.logger.error(`BDJobs response status ${response.status}`);
          break;
        }

        const $ = cheerio.load(response.data);
        const jobCards = this.findJobListings($);

        if (jobCards.length === 0) {
          this.logger.log('No more BDJobs listings found');
          break;
        }

        for (let i = 0; i < jobCards.length && jobList.length < resultsWanted; i++) {
          try {
            const card = $(jobCards[i]);
            const jobPost = await this.processJob($, card, client, input);
            if (jobPost && !seenIds.has(jobPost.id!)) {
              seenIds.add(jobPost.id!);
              jobList.push(jobPost);
            }
          } catch (err: any) {
            this.logger.warn(`BDJobs process error: ${err.message}`);
          }
        }

        page++;
        await randomSleep(this.delay * 1000, (this.delay + this.bandDelay) * 1000);
      } catch (err: any) {
        this.logger.error(`BDJobs scrape error: ${err.message}`);
        diagnostics = classifyScrapeError(err);
        break;
      }
    }

    return new JobResponseDto(jobList.slice(0, resultsWanted), diagnostics);
  }

  private findJobListings($: cheerio.CheerioAPI): any[] {
    for (const selector of BDJOBS_JOB_SELECTORS) {
      const [tag, className] = selector.split('.');
      const elements = $(tag + (className ? `.${className}` : '')).toArray();
      if (elements.length > 0) return elements;
    }

    // Fallback: find parent elements of job detail links
    const links = $('a[href*="jobdetail" i]').toArray();
    return links.length > 0 ? links.map((link) => (link as any).parent || link) : [];
  }

  private async processJob(
    $: cheerio.CheerioAPI,
    card: cheerio.Cheerio<any>,
    client: any,
    input: ScraperInputDto,
  ): Promise<JobPostDto | null> {
    const jobLink = card.find('a[href*="jobdetail" i]');
    if (!jobLink.length) return null;

    let jobUrl = jobLink.attr('href') ?? '';
    if (!jobUrl.startsWith('http')) {
      jobUrl = `${this.baseUrl}/${jobUrl.replace(/^\//, '')}`;
    }

    const jobId = jobUrl.includes('jobid=')
      ? jobUrl.split('jobid=')[1]?.split('&')[0] ?? `bdjobs-${this.hashCode(jobUrl)}`
      : `bdjobs-${this.hashCode(jobUrl)}`;

    const title = jobLink.text().trim() || 'N/A';

    // Company
    const companyEl = card.find('[class*="comp-name" i], [class*="company" i]');
    const companyName = companyEl.text().trim() || 'N/A';

    // Location
    const locationEl = card.find('[class*="locon" i], [class*="location" i]');
    const locationText = locationEl.text().trim() || 'Dhaka, Bangladesh';
    const locationParts = locationText.split(',');
    const location = new LocationDto({
      city: locationParts[0]?.trim() || null,
      state: locationParts.length > 1 ? locationParts[1].trim() : null,
      country: Country.BANGLADESH,
    });

    // Date
    const dateEl = card.find('[class*="date" i], [class*="deadline" i]');
    const datePosted = dateEl.length ? this.parseDate(dateEl.text().trim()) : null;

    // Remote check
    const remoteKeywords = ['remote', 'work from home', 'wfh', 'home based'];
    const isRemote = remoteKeywords.some((kw) => `${title} ${location.displayLocation()}`.toLowerCase().includes(kw));

    const jobPost = new JobPostDto({
      id: jobId,
      title,
      companyName,
      location,
      datePosted,
      jobUrl,
      isRemote,
      site: Site.BDJOBS,
    });

    // Fetch description
    try {
      const details = await this.getJobDetails(client, jobUrl, input.descriptionFormat);
      if (details.description) jobPost.description = details.description;
      if (details.jobType) jobPost.jobType = details.jobType;
      if (details.companyIndustry) jobPost.companyIndustry = details.companyIndustry;
    } catch {
      // Ignore description fetch failures
    }

    return jobPost;
  }

  private async getJobDetails(
    client: any,
    jobUrl: string,
    format?: DescriptionFormat,
  ): Promise<{ description?: string; jobType?: any; companyIndustry?: string }> {
    const response = await client.get(jobUrl, { timeout: 60000 });
    if (response.status !== 200) return {};

    const $ = cheerio.load(response.data);

    // Description
    let description = '';
    const jobContentDiv = $('div.jobcontent');
    if (jobContentDiv.length) {
      const respHeading = jobContentDiv.find('h4#job_resp, h4:contains("Responsibilities"), h5:contains("Responsibilities")');
      if (respHeading.length) {
        const parts: string[] = [];
        let sibling = respHeading.next();
        while (sibling.length && !['hr', 'h4', 'h5'].includes(String(sibling.prop('tagName') ?? '').toLowerCase())) {
          if (sibling.is('ul')) {
            sibling.find('li').each((_, li) => { parts.push($(li).text().trim()); });
          } else if (sibling.is('p')) {
            parts.push(sibling.text().trim());
          }
          sibling = sibling.next();
        }
        description = parts.join('\n');
      }
    }

    if (!description) {
      const descEl = $('[class*="job-description" i], [class*="details" i], [class*="requirements" i]');
      if (descEl.length) {
        description = removeAttributes(descEl.html() ?? '');
        if (format === DescriptionFormat.MARKDOWN) {
          description = markdownConverter(description) ?? description;
        }
      }
    }

    return { description: description || undefined };
  }

  private parseDate(dateText: string): string | null {
    if (dateText.includes('Deadline:')) {
      dateText = dateText.replace('Deadline:', '').trim();
    }
    return toDateOnly(dateText);
  }

  private hashCode(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash |= 0;
    }
    return Math.abs(hash);
  }
}
