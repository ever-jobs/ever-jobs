import { Injectable, Logger } from '@nestjs/common';
import {
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
} from '@ever-jobs/common';
import { TEAMTAILOR_API_URL, TEAMTAILOR_HEADERS } from './teamtailor.constants';
import { TeamtailorJob, TeamtailorResponse } from './teamtailor.types';

@Injectable()
export class TeamtailorService implements IScraper {
  private readonly logger = new Logger(TeamtailorService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug) {
      this.logger.warn('No companySlug provided for Teamtailor scraper');
      return new JobResponseDto([]);
    }

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(TEAMTAILOR_HEADERS);

    const url = `${TEAMTAILOR_API_URL}/${encodeURIComponent(companySlug)}`;

    try {
      this.logger.log(`Fetching Teamtailor jobs for company: ${companySlug}`);
      const response = await client.get(url);
      const data: TeamtailorResponse = response.data ?? { data: [] };
      const jobs = data.data ?? [];

      if (!Array.isArray(jobs)) {
        this.logger.warn(`Unexpected Teamtailor response format for ${companySlug}`);
        return new JobResponseDto([]);
      }

      this.logger.log(`Teamtailor: found ${jobs.length} raw jobs for ${companySlug}`);

      const resultsWanted = input.resultsWanted ?? 100;
      const jobPosts: JobPostDto[] = [];

      for (const job of jobs) {
        if (jobPosts.length >= resultsWanted) break;

        try {
          const post = this.processJob(job, companySlug, input.descriptionFormat);
          if (post) {
            jobPosts.push(post);
          }
        } catch (err: any) {
          this.logger.warn(`Error processing Teamtailor job ${job.id}: ${err.message}`);
        }
      }

      return new JobResponseDto(jobPosts);
    } catch (err: any) {
      this.logger.error(`Teamtailor scrape error for ${companySlug}: ${err.message}`);
      return new JobResponseDto([]);
    }
  }

  private processJob(
    job: TeamtailorJob,
    companySlug: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const attrs = job.attributes;
    const title = attrs?.title;
    if (!title) return null;

    // Description from body (HTML)
    let description: string | null = null;
    if (attrs.body) {
      if (format === DescriptionFormat.HTML) {
        description = attrs.body;
      } else if (format === DescriptionFormat.MARKDOWN) {
        description = markdownConverter(attrs.body) ?? attrs.body;
      } else {
        description = htmlToPlainText(attrs.body);
      }
    }

    // Location from city/region/country
    const location = new LocationDto({
      city: attrs.city ?? null,
      state: attrs.region ?? null,
      country: attrs.country ?? null,
    });

    // Apply URL
    const applyUrl = attrs['apply-url'] ?? attrs['external-url'] ?? null;

    // Job URL from links
    const jobUrl = job.links?.['careersite-url']
      ?? applyUrl
      ?? `https://career.teamtailor.com/${companySlug}/jobs/${job.id}`;

    // Date posted
    const createdAt = attrs['created-at'] ?? null;
    const datePosted = createdAt
      ? new Date(createdAt).toISOString().split('T')[0]
      : null;

    // Department from relationships
    const departmentId = job.relationships?.department?.data?.id ?? null;

    return new JobPostDto({
      id: `teamtailor-${job.id}`,
      title,
      companyName: companySlug,
      jobUrl,
      location,
      description,
      datePosted,
      isRemote: attrs.remote ?? false,
      emails: extractEmails(description),
      site: Site.TEAMTAILOR,
      // ATS-specific fields
      atsId: job.id,
      atsType: 'teamtailor',
      department: departmentId,
      employmentType: attrs['employment-type'] ?? null,
      applyUrl,
    });
  }
}
