import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper,
  ScraperInputDto,
  JobResponseDto,
  JobPostDto,
  LocationDto,
  CompensationDto,
  Site,
  JobType,
  DescriptionFormat,
  getJobTypeFromString,
} from '@ever-jobs/models';
import {
  createHttpClient,
  htmlToPlainText,
  markdownConverter,
  extractEmails,
  parseJobPostingLd,
  jobPostingLdToCompensation,
  resolveCompensation,
  JobPostingLd,
  JobPostingLdLocation,
  toDateOnly,
} from '@ever-jobs/common';
import { JSONLD_HEADERS } from './jsonld.constants';

/**
 * Generic, last-resort harvester for pages whose primary structured source is a
 * schema.org `JobPosting` JSON-LD block (Spec 5022). Given a careers/job page
 * URL (`companyUrl`), it fetches the HTML, parses every embedded `JobPosting`
 * via the shared {@link parseJobPostingLd} helper, and emits one job per
 * posting. Intended for sites without a recognised ATS — not a replacement for
 * ATS plugins that already expose first-party JSON/REST feeds.
 */
@SourcePlugin({
  site: Site.JSONLD,
  name: 'JSON-LD',
  category: 'job-board',
  description:
    'Generic schema.org JobPosting (JSON-LD) harvester for a careers/job page URL.',
})
@Injectable()
export class JsonLdService implements IScraper {
  private readonly logger = new Logger(JsonLdService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const pageUrl = input.companyUrl;
    if (!pageUrl) {
      this.logger.warn('No companyUrl provided for JSON-LD scraper');
      return new JobResponseDto([]);
    }

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(JSONLD_HEADERS);

    let html: string;
    try {
      this.logger.log(`JSON-LD: fetching ${pageUrl}`);
      const response = await client.get<string>(pageUrl, {
        responseType: 'text',
      });
      html = typeof response.data === 'string' ? response.data : '';
    } catch (err: any) {
      this.logger.error(`JSON-LD fetch error for ${pageUrl}: ${err.message}`);
      return new JobResponseDto([], classifyScrapeError(err));
    }

    const postings = parseJobPostingLd(html);
    if (postings.length === 0) {
      this.logger.warn(`JSON-LD: no JobPosting blocks found at ${pageUrl}`);
      return new JobResponseDto([]);
    }

    const resultsWanted = input.resultsWanted ?? 100;
    const jobs: JobPostDto[] = [];
    postings.slice(0, resultsWanted).forEach((posting, i) => {
      try {
        const post = this.processPosting(posting, pageUrl, input.descriptionFormat);
        if (post) jobs.push(post);
      } catch (err: any) {
        this.logger.warn(`Error processing JSON-LD posting ${i}: ${err.message}`);
      }
    });

    this.logger.log(`JSON-LD: mapped ${jobs.length} jobs from ${pageUrl}`);
    return new JobResponseDto(jobs);
  }

  private processPosting(
    posting: JobPostingLd,
    pageUrl: string,
    format?: DescriptionFormat,
  ): JobPostDto | null {
    const title = posting.title;
    if (!title) return null;

    const jobUrl = posting.url ?? pageUrl;
    const description = this.formatDescription(posting.description, format);

    const location = this.buildLocation(posting.locations, posting.remote);

    const compensation: CompensationDto | null = resolveCompensation({
      structured: jobPostingLdToCompensation(posting.baseSalary),
      text: description,
    });
    const salarySource = posting.baseSalary ? 'structured' : 'description';

    const jobTypes = this.mapJobTypes(posting.employmentType);

    const datePosted = posting.datePosted
      ? toDateOnly(posting.datePosted)
      : null;

    return new JobPostDto({
      id: `jsonld-${this.hashUrl(jobUrl)}`,
      title,
      companyName: posting.hiringOrganizationName ?? null,
      companyUrl: posting.hiringOrganizationUrl ?? null,
      jobUrl,
      ...(posting.applyUrl ? { applyUrl: posting.applyUrl } : {}),
      location,
      description,
      datePosted,
      isRemote: posting.remote,
      ...(jobTypes.length > 0 ? { jobType: jobTypes } : {}),
      ...(posting.employmentType
        ? { employmentType: posting.employmentType }
        : {}),
      ...(compensation ? { compensation, salarySource } : {}),
      emails: extractEmails(description),
      site: Site.JSONLD,
    });
  }

  /**
   * Map schema.org `employmentType` to {@link JobType}s. Handles the underscore
   * spelling (`FULL_TIME`) that {@link getJobTypeFromString} doesn't normalise,
   * and the `, `-joined multi-value form produced by the shared helper.
   */
  private mapJobTypes(employmentType: string | null): JobType[] {
    if (!employmentType) return [];
    const seen = new Set<JobType>();
    for (const token of employmentType.split(',')) {
      const mapped = getJobTypeFromString(token.replace(/_/g, ''));
      if (mapped) seen.add(mapped);
    }
    return [...seen];
  }

  /** First structured location; remote-only postings become `Remote`. */
  private buildLocation(
    locations: JobPostingLdLocation[],
    isRemote: boolean,
  ): LocationDto | null {
    const first = locations[0];
    if (!first) {
      return isRemote ? new LocationDto({ city: 'Remote' }) : null;
    }
    return new LocationDto({
      city: first.city ?? (isRemote ? 'Remote' : null),
      state: first.region,
      country: first.country,
    });
  }

  /** Short stable id from the job URL (avoids leaking the full URL into ids). */
  private hashUrl(url: string): string {
    let hash = 0;
    for (let i = 0; i < url.length; i++) {
      hash = (hash * 31 + url.charCodeAt(i)) | 0;
    }
    return (hash >>> 0).toString(36);
  }

  private formatDescription(
    html: string | null | undefined,
    format?: DescriptionFormat,
  ): string | null {
    if (!html || !html.trim()) return null;
    if (format === DescriptionFormat.HTML) return html;
    if (format === DescriptionFormat.MARKDOWN) {
      return markdownConverter(html) ?? html;
    }
    return htmlToPlainText(html);
  }
}
