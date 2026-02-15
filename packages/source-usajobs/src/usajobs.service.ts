import { Injectable, Logger } from '@nestjs/common';
import {
  IScraper,
  ScraperInputDto,
  JobResponseDto,
  JobPostDto,
  LocationDto,
  CompensationDto,
  CompensationInterval,
  DescriptionFormat,
  Site,
} from '@ever-jobs/models';
import {
  createHttpClient,
  htmlToPlainText,
  markdownConverter,
  extractEmails,
} from '@ever-jobs/common';
import {
  USAJOBS_API_URL,
  USAJOBS_HEADERS,
  USAJOBS_MAX_PAGE_SIZE,
  USAJOBS_DEFAULT_RESULTS,
} from './usajobs.constants';
import { UsaJobsResponse, UsaJobsItem, UsaJobsRemuneration } from './usajobs.types';

/**
 * Map USAJobs rate interval descriptions to CompensationInterval.
 */
const RATE_INTERVAL_MAP: Record<string, CompensationInterval> = {
  'Per Year': CompensationInterval.YEARLY,
  'Per Month': CompensationInterval.MONTHLY,
  'Per Week': CompensationInterval.WEEKLY,
  'Per Day': CompensationInterval.DAILY,
  'Per Hour': CompensationInterval.HOURLY,
};

@Injectable()
export class UsajobsService implements IScraper {
  private readonly logger = new Logger(UsajobsService.name);
  private readonly defaultApiKey: string | null;
  private readonly defaultEmail: string | null;

  constructor() {
    this.defaultApiKey = process.env.USAJOBS_API_KEY ?? null;
    this.defaultEmail = process.env.USAJOBS_EMAIL ?? null;
    if (!this.defaultApiKey || !this.defaultEmail) {
      this.logger.warn(
        'USAJOBS_API_KEY or USAJOBS_EMAIL not set. USAJobs searches will return empty results ' +
          'unless per-request auth is provided via input.auth.usajobs. ' +
          'Get your key at https://developer.usajobs.gov/APIRequest/Index',
      );
    }
  }

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const apiKey = input.auth?.usajobs?.apiKey ?? this.defaultApiKey;
    const email = input.auth?.usajobs?.email ?? this.defaultEmail;

    if (!apiKey || !email) {
      this.logger.warn('Skipping USAJobs search — credentials not configured');
      return new JobResponseDto([]);
    }

    const resultsWanted = input.resultsWanted ?? USAJOBS_DEFAULT_RESULTS;
    const pageSize = Math.min(resultsWanted, USAJOBS_MAX_PAGE_SIZE);

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders({
      ...USAJOBS_HEADERS,
      'Authorization-Key': apiKey,
      'User-Agent': email,
    });

    const jobs: JobPostDto[] = [];
    const seenIds = new Set<string>();
    let page = 1;

    while (jobs.length < resultsWanted) {
      const params: Record<string, string | number> = {
        Keyword: input.searchTerm ?? '',
        ResultsPerPage: pageSize,
        Page: page,
        Fields: 'Full',
      };

      if (input.location) {
        params.LocationName = input.location;
      }

      if (input.hoursOld) {
        const daysOld = Math.ceil(input.hoursOld / 24);
        params.DatePosted = daysOld;
      }

      this.logger.log(`Fetching USAJobs (page=${page}, pageSize=${pageSize})`);

      try {
        const response = await client.get<UsaJobsResponse>(USAJOBS_API_URL, { params });

        const searchResult = response.data?.SearchResult;
        if (!searchResult) {
          this.logger.warn('USAJobs returned no SearchResult object');
          break;
        }

        const items = searchResult.SearchResultItems ?? [];
        if (items.length === 0) {
          this.logger.log('No more USAJobs results available');
          break;
        }

        this.logger.log(
          `USAJobs returned ${items.length} results (total: ${searchResult.SearchResultCountAll})`,
        );

        for (const item of items) {
          if (jobs.length >= resultsWanted) break;

          const jobId = item.MatchedObjectId;
          if (seenIds.has(jobId)) continue;
          seenIds.add(jobId);

          try {
            const job = this.mapJob(item, input.descriptionFormat);
            if (job) jobs.push(job);
          } catch (err: any) {
            this.logger.warn(`Error mapping USAJobs item ${jobId}: ${err.message}`);
          }
        }

        // Stop if we got fewer results than requested (last page)
        if (items.length < pageSize) break;

        page++;
      } catch (err: any) {
        this.logger.error(`USAJobs scrape error: ${err.message}`);
        break;
      }
    }

    return new JobResponseDto(jobs);
  }

  /**
   * Map a USAJobs search result item to a JobPostDto.
   */
  private mapJob(item: UsaJobsItem, descriptionFormat?: DescriptionFormat): JobPostDto | null {
    const desc = item.MatchedObjectDescriptor;
    if (!desc) return null;

    // jobUrl is REQUIRED — skip if missing
    const jobUrl = desc.PositionURI;
    if (!jobUrl) return null;

    const title = desc.PositionTitle;
    if (!title) return null;

    // Build description from JobSummary or QualificationSummary
    let description: string | null =
      desc.UserArea?.Details?.JobSummary || desc.QualificationSummary || null;

    // Append major duties if available
    const majorDuties = desc.UserArea?.Details?.MajorDuties;
    if (majorDuties && majorDuties.length > 0) {
      const dutiesText = majorDuties.map((d) => `- ${d}`).join('\n');
      description = description
        ? `${description}\n\nMajor Duties:\n${dutiesText}`
        : `Major Duties:\n${dutiesText}`;
    }

    // Apply description format conversion
    if (description) {
      if (descriptionFormat === DescriptionFormat.PLAIN) {
        description = htmlToPlainText(description);
      } else if (descriptionFormat === DescriptionFormat.MARKDOWN) {
        // Only convert if it contains HTML tags
        if (/<[^>]+>/.test(description)) {
          description = markdownConverter(description) ?? description;
        }
      }
      // HTML format: pass through as-is
    }

    // Build location from first PositionLocation
    const loc = desc.PositionLocation?.[0];
    const location = new LocationDto({
      city: loc?.CityName ?? null,
      state: loc?.CountrySubDivisionCode ?? null,
      country: loc?.CountryCode ?? null,
    });

    // Build compensation from first PositionRemuneration
    const compensation = this.mapCompensation(desc.PositionRemuneration?.[0]);

    // Parse publication date
    let datePosted: string | null = null;
    if (desc.PublicationStartDate) {
      try {
        datePosted = new Date(desc.PublicationStartDate).toISOString().split('T')[0];
      } catch {
        datePosted = null;
      }
    }

    return new JobPostDto({
      id: `usajobs-${item.MatchedObjectId}`,
      title,
      companyName: desc.OrganizationName ?? null,
      jobUrl,
      location,
      description,
      compensation,
      datePosted,
      jobType: null,
      isRemote: null,
      emails: extractEmails(description),
      site: Site.USAJOBS,
    });
  }

  /**
   * Map USAJobs remuneration data to a CompensationDto.
   */
  private mapCompensation(remuneration?: UsaJobsRemuneration): CompensationDto | null {
    if (!remuneration) return null;

    const minAmount = parseFloat(remuneration.MinimumRange);
    const maxAmount = parseFloat(remuneration.MaximumRange);

    // Skip if both are invalid
    if (isNaN(minAmount) && isNaN(maxAmount)) return null;

    const interval =
      RATE_INTERVAL_MAP[remuneration.Description] ??
      RATE_INTERVAL_MAP[remuneration.RateIntervalCode] ??
      CompensationInterval.YEARLY;

    return new CompensationDto({
      interval,
      minAmount: isNaN(minAmount) ? null : minAmount,
      maxAmount: isNaN(maxAmount) ? null : maxAmount,
      currency: 'USD',
    });
  }
}
