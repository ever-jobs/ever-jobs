import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper,
  ScraperInputDto,
  JobResponseDto,
  JobPostDto,
  LocationDto,
  Site,
  DescriptionFormat,
} from '@ever-jobs/models';
import {
  createHttpClient,
  htmlToPlainText,
  markdownConverter,
  extractEmails,
  toDateOnly,
} from '@ever-jobs/common';
import { TALENTLYFT_API_URL, TALENTLYFT_HEADERS } from './talentlyft.constants';
import { TalentLyftJob, TalentLyftResponse } from './talentlyft.types';

@SourcePlugin({
  site: Site.TALENTLYFT,
  name: 'TalentLyft',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class TalentLyftService implements IScraper {
  private readonly logger = new Logger(TalentLyftService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const apiKey = process.env.TALENTLYFT_API_KEY;
    if (!apiKey) {
      this.logger.warn('No TALENTLYFT_API_KEY found in environment');
      return new JobResponseDto([]);
    }

    const companySlug = input.companySlug;
    if (!companySlug) {
      this.logger.warn('No companySlug provided for TalentLyft scraper');
      return new JobResponseDto([]);
    }

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders({
      ...TALENTLYFT_HEADERS,
      Authorization: `Bearer ${apiKey}`,
    });

    const resultsWanted = input.resultsWanted ?? 20;
    const url = `${TALENTLYFT_API_URL}/${encodeURIComponent(companySlug)}/jobs?page=1&perPage=${resultsWanted}`;

    try {
      this.logger.log(`Fetching TalentLyft jobs for company: ${companySlug}`);
      const response = await client.get(url);
      const data: TalentLyftResponse = response.data ?? {};
      let jobs: TalentLyftJob[] = data.Results ?? [];

      if (!Array.isArray(jobs)) {
        this.logger.warn(`Unexpected TalentLyft response format for ${companySlug}`);
        return new JobResponseDto([]);
      }

      this.logger.log(`TalentLyft: found ${jobs.length} raw jobs for ${companySlug}`);

      // Filter by searchTerm (case-insensitive match on Title and Description)
      if (input.searchTerm) {
        const term = input.searchTerm.toLowerCase();
        jobs = jobs.filter((job) => {
          const title = job.Title?.toLowerCase() ?? '';
          const desc = job.Description?.toLowerCase() ?? '';
          return title.includes(term) || desc.includes(term);
        });
      }

      const jobPosts: JobPostDto[] = [];

      for (const job of jobs) {
        if (jobPosts.length >= resultsWanted) break;

        try {
          const post = this.processJob(job, companySlug, input.descriptionFormat);
          if (post) {
            jobPosts.push(post);
          }
        } catch (err: any) {
          this.logger.warn(`Error processing TalentLyft job ${job.Id}: ${err.message}`);
        }
      }

      return new JobResponseDto(jobPosts);
    } catch (err: any) {
      this.logger.error(`TalentLyft scrape error for ${companySlug}: ${err.message}`);
      return new JobResponseDto([], classifyScrapeError(err));
    }
  }

  private processJob(
    job: TalentLyftJob,
    companySlug: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const title = job.Title;
    if (!title) return null;

    // Description is HTML content
    let description: string | null = null;
    if (job.Description) {
      if (format === DescriptionFormat.HTML) {
        description = job.Description;
      } else if (format === DescriptionFormat.MARKDOWN) {
        description = markdownConverter(job.Description) ?? job.Description;
      } else {
        description = htmlToPlainText(job.Description);
      }
    }

    // Location from Location string field
    const locationStr = job.Location ?? null;
    const location = locationStr
      ? new LocationDto({ city: locationStr })
      : null;

    // Remote detection from location string
    const isRemote = locationStr?.toLowerCase().includes('remote') ?? false;

    // Job URL from Url field
    const jobUrl = job.Url || undefined;

    // Date posted
    const datePosted = job.CreatedAt
      ? toDateOnly(job.CreatedAt)
      : null;

    return new JobPostDto({
      id: `talentlyft-${job.Id}`,
      title,
      companyName: companySlug,
      jobUrl,
      location,
      description,
      datePosted,
      isRemote,
      emails: extractEmails(description),
      site: Site.TALENTLYFT,
      // ATS-specific fields
      atsId: job.Id?.toString() ?? null,
      atsType: 'talentlyft',
      department: job.Department ?? null,
    });
  }
}
