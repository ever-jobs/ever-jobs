import { SourcePlugin } from '@ever-jobs/plugin';

// WIP: Taleo API response format may vary per company deployment.
import { Injectable, Logger } from '@nestjs/common';
import {
  IScraper,
  ScraperInputDto,
  JobResponseDto,
  JobPostDto,
  LocationDto,
  Site,
} from '@ever-jobs/models';
import {
  createHttpClient,
  randomSleep,
  extractEmails,
  toDateOnly,
} from '@ever-jobs/common';
import {
  TALEO_HEADERS,
  TALEO_PAGE_SIZE,
  TALEO_DELAY_MIN,
  TALEO_DELAY_MAX,
  parseTaleoSlug,
  buildTaleoSearchUrl,
} from './taleo.constants';
import {
  TaleoJobListItem,
  TaleoSearchPayload,
  TaleoSearchResponse,
} from './taleo.types';

@SourcePlugin({
  site: Site.TALEO,
  name: 'Taleo',
  category: 'ats',
  isAts: true,
})
@Injectable()
export class TaleoService implements IScraper {
  private readonly logger = new Logger(TaleoService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const companySlug = input.companySlug;
    if (!companySlug) {
      this.logger.warn('No companySlug provided for Taleo scraper');
      return new JobResponseDto([]);
    }

    const { company, careerSection } = parseTaleoSlug(companySlug);
    const apiUrl = buildTaleoSearchUrl(company);

    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      timeout: input.requestTimeout,
    });
    client.setHeaders(TALEO_HEADERS);

    const resultsWanted = input.resultsWanted ?? 100;
    const jobPosts: JobPostDto[] = [];
    let pageNo = 1;

    try {
      this.logger.log(
        `Fetching Taleo jobs for ${company} (careerSection: ${careerSection})`,
      );

      while (jobPosts.length < resultsWanted) {
        const payload: TaleoSearchPayload = {
          multilineEnabled: false,
          sortingSelection: {
            sortBySelectionParam: 'postedDate',
            ascendingSortingOrder: 'false',
          },
          pageNo,
          pageSize: TALEO_PAGE_SIZE,
          keyword: input.searchTerm ?? '',
          location: input.location ?? '',
        };

        const response = await client.post(apiUrl, payload);
        const data: TaleoSearchResponse = response.data ?? {};
        const listings = data.requisitionList ?? [];

        if (listings.length === 0) break;

        this.logger.log(
          `Taleo: fetched ${listings.length} jobs on page ${pageNo} for ${company}` +
            `${data.totalCount ? ` (total: ${data.totalCount})` : ''}`,
        );

        for (const listing of listings) {
          if (jobPosts.length >= resultsWanted) break;

          try {
            const post = this.processListing(
              listing,
              company,
              careerSection,
            );
            if (post) {
              jobPosts.push(post);
            }
          } catch (err: any) {
            this.logger.warn(
              `Error processing Taleo listing: ${err.message}`,
            );
          }
        }

        // If we got less than page size, no more results
        if (listings.length < TALEO_PAGE_SIZE) break;

        pageNo++;

        // Respect rate limiting
        await randomSleep(TALEO_DELAY_MIN, TALEO_DELAY_MAX);
      }

      this.logger.log(`Taleo total: ${jobPosts.length} jobs for ${company}`);
      return new JobResponseDto(jobPosts);
    } catch (err: any) {
      this.logger.error(`Taleo scrape error for ${company}: ${err.message}`);
      return new JobResponseDto(jobPosts);
    }
  }

  private processListing(
    listing: TaleoJobListItem,
    company: string,
    careerSection: string,
  ): JobPostDto | null {
    const title = listing.title;
    if (!title) return null;

    const contestNo = listing.contestNo ?? null;

    // Build job detail URL
    const jobUrl = contestNo
      ? `https://${company}.taleo.net/careersection/${careerSection}/jobdetail.ftl?job=${contestNo}`
      : `https://${company}.taleo.net/careersection/${careerSection}/jobdetail.ftl`;

    // Location
    const locationStr = listing.primaryLocation ?? null;
    const location = locationStr
      ? new LocationDto({ city: locationStr })
      : null;

    // Remote detection
    const isRemote =
      locationStr?.toLowerCase().includes('remote') ?? false;

    // Date: prefer postingDate, fall back to openingDate
    const rawDate = listing.postingDate ?? listing.openingDate ?? null;
    const datePosted = rawDate
      ? (() => {
          try {
            return toDateOnly(rawDate);
          } catch {
            return rawDate;
          }
        })()
      : null;

    return new JobPostDto({
      id: `taleo-${contestNo ?? title.replace(/\s+/g, '-').toLowerCase()}`,
      title,
      companyName: listing.organization ?? company,
      jobUrl,
      location,
      datePosted,
      isRemote,
      site: Site.TALEO,
      // ATS-specific fields
      atsId: contestNo,
      atsType: 'taleo',
      department: listing.jobField ?? null,
    });
  }
}
