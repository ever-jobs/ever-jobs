import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  ScrapeDiagnostics,
  IScraper,
  ScraperInputDto,
  JobResponseDto,
  JobPostDto,
  LocationDto,
  DescriptionFormat,
  Site,
} from '@ever-jobs/models';
import {
  createHttpClient,
  htmlToPlainText,
  markdownConverter,
  extractEmails,
  toDateOnly,
} from '@ever-jobs/common';
import {
  AUTHENTICJOBS_API_URL,
  AUTHENTICJOBS_DEFAULT_PARAMS,
  AUTHENTICJOBS_METHOD_SEARCH,
  AUTHENTICJOBS_DEFAULT_RESULTS,
  AUTHENTICJOBS_HEADERS,
} from './authenticjobs.constants';
import { AuthenticJob, AuthenticJobsApiResponse } from './authenticjobs.types';

@SourcePlugin({
  site: Site.AUTHENTICJOBS,
  name: 'AuthenticJobs',
  category: 'niche',
})
@Injectable()
export class AuthenticJobsService implements IScraper {
  private readonly logger = new Logger(AuthenticJobsService.name);
  private readonly defaultApiKey: string | null;

  constructor() {
    this.defaultApiKey = process.env.AUTHENTICJOBS_API_KEY ?? null;
    if (!this.defaultApiKey) {
      this.logger.warn(
        'AUTHENTICJOBS_API_KEY is not set. Authentic Jobs searches will return empty results. ' +
          'Get your key at https://authenticjobs.com/api/',
      );
    }
  }

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const apiKey = this.defaultApiKey;

    if (!apiKey) {
      this.logger.warn('Skipping Authentic Jobs search — API key not configured');
      return new JobResponseDto([]);
    }

    const resultsWanted = input.resultsWanted ?? AUTHENTICJOBS_DEFAULT_RESULTS;
    const count = Math.min(resultsWanted, 100); // API max is 100 per page

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(AUTHENTICJOBS_HEADERS);

    const jobs: JobPostDto[] = [];
    let diagnostics: ScrapeDiagnostics | undefined;
    const seenIds = new Set<string>();
    let page = 1;

    while (jobs.length < resultsWanted) {
      // Build query params
      const params: Record<string, string> = {
        ...AUTHENTICJOBS_DEFAULT_PARAMS,
        method: AUTHENTICJOBS_METHOD_SEARCH,
        api_key: apiKey,
        page: String(page),
        count: String(count),
      };

      if (input.searchTerm) {
        params.keyword = input.searchTerm;
      }

      // Try to extract city/state from location string (e.g. "San Francisco, CA")
      if (input.location) {
        const locationParts = this.parseLocation(input.location);
        if (locationParts.city) {
          params.city = locationParts.city;
        }
        if (locationParts.state) {
          params.state = locationParts.state;
        }
      }

      params.sort = 'date-posted-desc';

      const queryString = new URLSearchParams(params).toString();
      const url = `${AUTHENTICJOBS_API_URL}?${queryString}`;

      this.logger.log(`Fetching Authentic Jobs page ${page}: ${url}`);

      try {
        const response = await client.get(url);
        const data = response.data as AuthenticJobsApiResponse;

        const listings = data?.listings?.listing;
        if (!listings || !Array.isArray(listings) || listings.length === 0) {
          this.logger.log('No more Authentic Jobs listings available');
          break;
        }

        this.logger.log(`Authentic Jobs returned ${listings.length} listings on page ${page}`);

        for (const listing of listings) {
          if (jobs.length >= resultsWanted) break;

          const jobId = `authenticjobs-${listing.id}`;
          if (seenIds.has(jobId)) continue;
          seenIds.add(jobId);

          try {
            const job = this.mapJob(listing, input.descriptionFormat);
            if (job) jobs.push(job);
          } catch (err: any) {
            this.logger.warn(`Error mapping Authentic Jobs listing ${listing.id}: ${err.message}`);
          }
        }

        // If we got fewer listings than requested, there are no more pages
        if (listings.length < count) break;

        page++;
      } catch (err: any) {
        this.logger.error(`Authentic Jobs scrape error: ${err.message}`);
        break;
        diagnostics = classifyScrapeError(err);
      }
    }

    this.logger.log(`Authentic Jobs returned ${jobs.length} jobs`);
    return new JobResponseDto(jobs, diagnostics);
  }

  /**
   * Parse a location string into city and state components.
   * Handles formats like "San Francisco, CA", "New York", "Austin, Texas", etc.
   */
  private parseLocation(location: string): { city: string | null; state: string | null } {
    const trimmed = location.trim();
    if (!trimmed) return { city: null, state: null };

    const parts = trimmed.split(',').map((p) => p.trim());

    if (parts.length >= 2) {
      return {
        city: parts[0] || null,
        state: parts[1] || null,
      };
    }

    // Single value — treat as city
    return { city: parts[0] || null, state: null };
  }

  /**
   * Map a raw Authentic Jobs listing to a JobPostDto.
   */
  private mapJob(listing: AuthenticJob, descriptionFormat?: DescriptionFormat): JobPostDto | null {
    if (!listing.title) return null;

    // Build the job URL from the listing ID
    const jobUrl = listing.company?.url
      ? listing.company.url
      : `https://authenticjobs.com/job/${listing.id}`;

    // Process description (Authentic Jobs returns HTML)
    let description: string | null = listing.description ?? null;
    if (description) {
      if (descriptionFormat === DescriptionFormat.PLAIN) {
        description = htmlToPlainText(description);
      } else if (descriptionFormat === DescriptionFormat.MARKDOWN) {
        if (/<[^>]+>/.test(description)) {
          description = markdownConverter(description) ?? description;
        }
      }
      // HTML format: pass through as-is
    }

    // Append perks and how-to-apply to description if present
    if (listing.perks) {
      const perksText = descriptionFormat === DescriptionFormat.PLAIN
        ? htmlToPlainText(listing.perks)
        : descriptionFormat === DescriptionFormat.MARKDOWN && /<[^>]+>/.test(listing.perks)
          ? markdownConverter(listing.perks) ?? listing.perks
          : listing.perks;
      description = description
        ? `${description}\n\nPerks:\n${perksText}`
        : `Perks:\n${perksText}`;
    }

    if (listing.howto_apply) {
      const howtoText = descriptionFormat === DescriptionFormat.PLAIN
        ? htmlToPlainText(listing.howto_apply)
        : descriptionFormat === DescriptionFormat.MARKDOWN && /<[^>]+>/.test(listing.howto_apply)
          ? markdownConverter(listing.howto_apply) ?? listing.howto_apply
          : listing.howto_apply;
      description = description
        ? `${description}\n\nHow to Apply:\n${howtoText}`
        : `How to Apply:\n${howtoText}`;
    }

    // Build location from company object
    const locationStr = listing.company?.location ?? null;
    const locationParts = locationStr ? this.parseLocation(locationStr) : { city: null, state: null };
    const location = new LocationDto({
      city: locationParts.city,
      state: locationParts.state,
    });

    // Parse date
    let datePosted: string | null = null;
    if (listing.post_date) {
      try {
        datePosted = toDateOnly(listing.post_date);
      } catch {
        datePosted = null;
      }
    }

    return new JobPostDto({
      id: `authenticjobs-${listing.id}`,
      title: listing.title,
      companyName: listing.company?.name ?? null,
      jobUrl,
      location,
      description,
      compensation: null,
      datePosted,
      jobType: null,
      isRemote: listing.telecommuting ?? false,
      emails: extractEmails(description),
      site: Site.AUTHENTICJOBS,
    });
  }
}
