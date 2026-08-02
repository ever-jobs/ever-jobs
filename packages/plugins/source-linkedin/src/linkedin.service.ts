import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import * as cheerio from 'cheerio';
import {
  IScraper,
  ScraperInputDto,
  JobResponseDto,
  JobPostDto,
  LocationDto,
  CompensationDto,
  CompensationInterval,
  Country,
  DescriptionFormat,
  Site,
} from '@ever-jobs/models';
import {
  HttpClient,
  createHttpClient,
  LinkedInException,
  markdownConverter,
  plainConverter,
  extractEmails,
  randomSleep,
  toDateOnly,
} from '@ever-jobs/common';
import { LINKEDIN_HEADERS } from './linkedin.constants';
import { jobTypeCode, parseJobType, parseJobLevel, parseCompanyIndustry, isJobRemote } from './linkedin.utils';

@SourcePlugin({
  site: Site.LINKEDIN,
  name: 'LinkedIn',
  category: 'job-board',
})
@Injectable()
export class LinkedInService implements IScraper {
  private readonly logger = new Logger(LinkedInService.name);
  private readonly baseUrl = 'https://www.linkedin.com';
  private readonly delay = 3;
  private readonly bandDelay = 4;

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const client = createHttpClient(input);
    client.setHeaders(LINKEDIN_HEADERS);

    const jobList: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 15;
    let start = input.offset ?? 0;
    const seenIds = new Set<string>();

    while (jobList.length < resultsWanted) {
      this.logger.log(`Fetching LinkedIn jobs, offset ${start}`);

      try {
        const params = this.buildSearchParams(input, start);
        const response = await client.get(`${this.baseUrl}/jobs-guest/jobs/api/seeMoreJobPostings/search`, {
          params,
        });

        const $ = cheerio.load(response.data);
        const jobCards = $('li').has('.base-search-card');

        if (jobCards.length === 0) {
          this.logger.log('No more LinkedIn job results');
          break;
        }

        let newJobsFound = false;
        for (let i = 0; i < jobCards.length && jobList.length < resultsWanted; i++) {
          try {
            const card = jobCards.eq(i);
            const jobPost = this.extractJobFromCard($, card, input);
            if (jobPost && !seenIds.has(jobPost.id!)) {
              seenIds.add(jobPost.id!);
              jobList.push(jobPost);
              newJobsFound = true;
            }
          } catch (err: any) {
            this.logger.warn(`Error extracting LinkedIn job: ${err.message}`);
          }
        }

        if (!newJobsFound) break;

        start += 25;
        await randomSleep(this.delay * 1000, (this.delay + this.bandDelay) * 1000);
      } catch (err: any) {
        this.logger.error(`LinkedIn scrape error: ${err.message}`);
        break;
      }
    }

    // Fetch descriptions if requested
    if (input.linkedinFetchDescription) {
      for (const job of jobList) {
        try {
          const description = await this.fetchDescription(client, job.jobUrl, input.descriptionFormat);
          if (description) {
            job.description = description.text;
            job.jobLevel = description.jobLevel ?? job.jobLevel;
            job.companyIndustry = description.industry ?? job.companyIndustry;
            job.jobType = description.jobType ?? job.jobType;
            job.emails = extractEmails(description.text);
          }
          await randomSleep(this.delay * 1000, (this.delay + this.bandDelay) * 1000);
        } catch (err: any) {
          this.logger.warn(`Error fetching description for ${job.jobUrl}: ${err.message}`);
        }
      }
    }

    return new JobResponseDto(jobList);
  }

  private buildSearchParams(input: ScraperInputDto, start: number): Record<string, string | number> {
    const params: Record<string, string | number> = {
      keywords: input.searchTerm ?? '',
      location: input.location ?? '',
      distance: input.distance ?? 50,
      start,
      sortBy: 'DD',
    };

    if (input.easyApply) {
      params['f_AL'] = 'true';
    }
    if (input.jobType) {
      const code = jobTypeCode(input.jobType);
      if (code) params['f_JT'] = code;
    }
    if (input.isRemote) {
      params['f_WT'] = '2';
    }
    if (input.hoursOld) {
      params['f_TPR'] = `r${input.hoursOld * 3600}`;
    }
    if (input.linkedinCompanyIds && input.linkedinCompanyIds.length > 0) {
      params['f_C'] = input.linkedinCompanyIds.join(',');
    }

    return params;
  }

  private extractJobFromCard(
    $: cheerio.CheerioAPI,
    card: cheerio.Cheerio<any>,
    input: ScraperInputDto,
  ): JobPostDto | null {
    const linkEl = card.find('.base-search-card__full-link, a.base-card__full-link');
    const jobUrl = linkEl.attr('href')?.split('?')[0];
    if (!jobUrl) return null;

    const entityUrn = jobUrl.match(/view\/([^/]+)/)?.[1] ?? '';
    const jobId = `li-${entityUrn}`;

    const title = card.find('.base-search-card__title').text().trim();
    if (!title) return null;

    const companyName = card.find('.base-search-card__subtitle a').text().trim() || null;
    const companyUrl = card.find('.base-search-card__subtitle a').attr('href') || null;
    const locationStr = card.find('.job-search-card__location').text().trim();
    const datePosted = card.find('time').attr('datetime') || null;

    // Salary range from metadata
    const salaryEl = card.find('.job-search-card__salary-info');
    let compensation: CompensationDto | null = null;
    if (salaryEl.length) {
      const salaryText = salaryEl.text().trim();
      const match = salaryText.match(/\$?([\d,]+(?:\.\d+)?)\s*[-/]\s*\$?([\d,]+(?:\.\d+)?)/);
      if (match) {
        compensation = new CompensationDto({
          minAmount: parseFloat(match[1].replace(/,/g, '')),
          maxAmount: parseFloat(match[2].replace(/,/g, '')),
          currency: 'USD',
          interval: salaryText.toLowerCase().includes('hr')
            ? CompensationInterval.HOURLY
            : CompensationInterval.YEARLY,
        });
      }
    }

    const location = new LocationDto({ city: locationStr || null });
    const remote = isJobRemote(title, '', locationStr);

    return new JobPostDto({
      id: jobId,
      title,
      companyName,
      companyUrl,
      jobUrl,
      location,
      compensation,
      datePosted: datePosted ? toDateOnly(datePosted) : null,
      isRemote: remote,
      site: Site.LINKEDIN,
    });
  }

  private async fetchDescription(
    client: HttpClient,
    jobUrl: string,
    format?: DescriptionFormat,
  ): Promise<{ text: string; jobLevel?: string; industry?: string; jobType?: any } | null> {
    const response = await client.get(jobUrl);
    const $ = cheerio.load(response.data);

    const descriptionEl = $('.show-more-less-html__markup, .description__text');
    if (!descriptionEl.length) return null;

    const rawHtml = descriptionEl.html() ?? '';
    let text: string;
    if (format === DescriptionFormat.MARKDOWN) {
      text = markdownConverter(rawHtml) ?? rawHtml;
    } else if (format === DescriptionFormat.PLAIN) {
      text = plainConverter(rawHtml) ?? rawHtml;
    } else {
      text = rawHtml;
    }

    const criteriaSection = $('.description__job-criteria-list');
    const jobLevel = parseJobLevel($, criteriaSection);
    const industry = parseCompanyIndustry($, criteriaSection);
    const jobType = parseJobType($, criteriaSection);

    return { text, jobLevel: jobLevel ?? undefined, industry: industry ?? undefined, jobType };
  }
}
