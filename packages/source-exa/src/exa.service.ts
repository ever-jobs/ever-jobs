import { Injectable, Logger } from '@nestjs/common';
import Exa from 'exa-js';
import {
  IScraper,
  ScraperInputDto,
  JobResponseDto,
  JobPostDto,
  LocationDto,
  DescriptionFormat,
  Site,
} from '@ever-jobs/models';
import {
  markdownConverter,
  plainConverter,
  extractEmails,
} from '@ever-jobs/common';
import {
  DEFAULT_JOB_DOMAINS,
  DEFAULT_NUM_RESULTS,
  DEFAULT_SEARCH_TYPE,
} from './exa.constants';

@Injectable()
export class ExaService implements IScraper {
  private readonly logger = new Logger(ExaService.name);
  private readonly defaultExa: Exa | null;

  constructor() {
    const apiKey = process.env.EXA_API_KEY;
    if (!apiKey) {
      this.logger.warn(
        'EXA_API_KEY is not set. Exa searches will return empty results ' +
          'unless per-request auth is provided via input.auth.exa. ' +
          'Get your key at https://dashboard.exa.ai',
      );
      this.defaultExa = null;
      return;
    }
    try {
      this.defaultExa = new Exa(apiKey);
    } catch (err: any) {
      this.logger.error(`Failed to initialise Exa client: ${err.message}`);
      this.defaultExa = null;
    }
  }

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    // Resolve Exa client: per-request API key creates a fresh client
    let exa = this.defaultExa;
    const requestApiKey = input.auth?.exa?.apiKey;
    if (requestApiKey) {
      try {
        exa = new Exa(requestApiKey);
      } catch (err: any) {
        this.logger.error(`Failed to create Exa client from per-request key: ${err.message}`);
        return new JobResponseDto([]);
      }
    }

    if (!exa) {
      this.logger.warn('Skipping Exa search — client not initialised');
      return new JobResponseDto([]);
    }

    const numResults = input.resultsWanted ?? DEFAULT_NUM_RESULTS;

    // Build the query — combine search term with location and remote hints
    const queryParts: string[] = [];
    if (input.searchTerm) queryParts.push(input.searchTerm);
    if (input.location) queryParts.push(`in ${input.location}`);
    if (input.isRemote) queryParts.push('remote');
    queryParts.push('job posting');

    const query = queryParts.join(' ');
    this.logger.log(`Exa search: "${query}" (${numResults} results)`);

    try {
      // Calculate date filter if hoursOld is specified
      let startPublishedDate: string | undefined;
      if (input.hoursOld) {
        const since = new Date(Date.now() - input.hoursOld * 60 * 60 * 1000);
        startPublishedDate = since.toISOString().split('T')[0];
      }

      const response = await exa.searchAndContents(query, {
        numResults,
        type: DEFAULT_SEARCH_TYPE,
        includeDomains: DEFAULT_JOB_DOMAINS,
        startPublishedDate,
        text: true,
        summary: true,
      } as any);

      const results = response.results ?? [];
      this.logger.log(`Exa returned ${results.length} results`);

      const jobs: JobPostDto[] = [];

      for (const result of results) {
        try {
          const job = this.processResult(result, input.descriptionFormat);
          if (job) jobs.push(job);
        } catch (err: any) {
          this.logger.warn(`Error processing Exa result: ${err.message}`);
        }
      }

      return new JobResponseDto(jobs);
    } catch (err: any) {
      this.logger.error(`Exa scrape error: ${err.message}`);
      return new JobResponseDto([]);
    }
  }

  /**
   * Convert an Exa search result into a JobPostDto.
   */
  private processResult(result: any, format?: DescriptionFormat): JobPostDto | null {
    const url: string = result.url;
    if (!url) return null;

    // Extract title — Exa provides it directly
    const title = result.title ?? this.extractTitleFromUrl(url);
    if (!title) return null;

    // Try to extract company name from the URL or author field
    const companyName = result.author ?? this.extractCompanyFromUrl(url) ?? null;

    // Process description text
    let description = result.text ?? result.summary ?? null;
    if (description && format === DescriptionFormat.MARKDOWN) {
      // Exa text is already clean, but if it contains HTML tags, convert
      if (/<[^>]+>/.test(description)) {
        description = markdownConverter(description) ?? description;
      }
    } else if (description && format === DescriptionFormat.PLAIN) {
      if (/<[^>]+>/.test(description)) {
        description = plainConverter(description) ?? description;
      }
    }

    // Extract location from text if present
    const location = new LocationDto({});

    // Detect remote from title or description
    const titleAndDesc = `${title} ${description ?? ''}`.toLowerCase();
    const isRemote =
      titleAndDesc.includes('remote') ||
      titleAndDesc.includes('work from home') ||
      titleAndDesc.includes('wfh');

    // Parse published date
    const datePosted = result.publishedDate
      ? new Date(result.publishedDate).toISOString().split('T')[0]
      : null;

    return new JobPostDto({
      id: `exa-${this.hashUrl(url)}`,
      title,
      companyName,
      companyUrl: null,
      jobUrl: url,
      location,
      description,
      compensation: null,
      datePosted,
      jobType: null,
      isRemote,
      emails: extractEmails(description),
      site: Site.EXA,
    });
  }

  /**
   * Extract a company name from common job board URL patterns.
   */
  private extractCompanyFromUrl(url: string): string | null {
    try {
      const parsed = new URL(url);
      const host = parsed.hostname;

      // boards.greenhouse.io/company-name
      if (host === 'boards.greenhouse.io') {
        const parts = parsed.pathname.split('/').filter(Boolean);
        return parts[0] ? this.humanize(parts[0]) : null;
      }

      // jobs.ashbyhq.com/company-name
      if (host === 'jobs.ashbyhq.com') {
        const parts = parsed.pathname.split('/').filter(Boolean);
        return parts[0] ? this.humanize(parts[0]) : null;
      }

      // jobs.lever.co/company-name
      if (host === 'jobs.lever.co' || host.endsWith('.lever.co')) {
        const parts = parsed.pathname.split('/').filter(Boolean);
        return parts[0] ? this.humanize(parts[0]) : null;
      }

      // apply.workable.com/company-name
      if (host === 'apply.workable.com') {
        const parts = parsed.pathname.split('/').filter(Boolean);
        return parts[0] ? this.humanize(parts[0]) : null;
      }

      return null;
    } catch {
      return null;
    }
  }

  /**
   * Extract a title from a URL (fallback).
   */
  private extractTitleFromUrl(url: string): string | null {
    try {
      const parsed = new URL(url);
      const last = parsed.pathname.split('/').filter(Boolean).pop();
      return last ? this.humanize(last) : null;
    } catch {
      return null;
    }
  }

  /**
   * Convert a URL slug into a human-readable string.
   */
  private humanize(slug: string): string {
    return slug
      .replace(/[-_]/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .trim();
  }

  /**
   * Simple hash of a URL to create a deterministic ID.
   */
  private hashUrl(url: string): string {
    let hash = 0;
    for (let i = 0; i < url.length; i++) {
      const char = url.charCodeAt(i);
      hash = ((hash << 5) - hash + char) | 0;
    }
    return Math.abs(hash).toString(36);
  }
}
