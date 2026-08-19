import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Algolia — Hosted search and discovery APIs for websites and applications..
 *
 * Algolia is a software company providing hosted search and discovery
 * APIs that let developers add fast, relevant search, recommendations,
 * and related functionality to websites and applications. Its products
 * are delivered as a cloud-based service consumed via APIs and SDKs,
 * with a usage-based and subscription model. Hiring across direct
 * sales, customer solutions, support, and R&D spans Europe, North
 * America, and Australia, indicating a global B2B SaaS operation. The
 * company maintains a strong presence in France and the United States.
 *
 * Sector: Developer Tools / Search SaaS. HQ: Paris, France / San Francisco, USA.
 *
 * Highlights:
 *   - Provides API-first search, recommendation, and discovery
 *     services for web and mobile apps
 *   - Operates as a global B2B SaaS company with sales and support
 *     teams across Europe, North America, and Australia
 *   - Departments include Direct Sales, Customer Solutions, Customer
 *     Support/Care, Marketing, and R&D
 *   - Maintains offices and remote roles in France, Germany, the UK,
 *     the US, and Australia
 *
 * Source profile (Spec 229):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/algolia/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'Algolia'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 32 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/algolia/jobs';

@SourcePlugin({
  site: Site.ALGOLIA,
  name: 'Algolia',
  category: 'company',
})
@Injectable()
export class AlgoliaService implements IScraper {
  private readonly logger = new Logger(AlgoliaService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Algolia: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10: defensive trim of wire title padding.
        const title = (listing.title ?? '').trim();
        if (!title) continue;

        if (input.searchTerm) {
          const term = input.searchTerm.toLowerCase();
          const titleMatch = title.toLowerCase().includes(term);
          const deptMatch = (listing.departments?.[0]?.name ?? '')
            .toLowerCase()
            .includes(term);
          if (!titleMatch && !deptMatch) continue;
        }

        const jobId = listing.id ?? '';
        const id = `algolia-${jobId}`;

        const locationStr = listing.location?.name ?? null;
        const location = locationStr
          ? new LocationDto({ city: locationStr })
          : null;

        if (input.location && locationStr) {
          if (!locationStr.toLowerCase().includes(input.location.toLowerCase())) continue;
        }

        // D-11: defensive trim of wire department padding.
        const deptRaw = listing.departments?.[0]?.name ?? null;
        const department = deptRaw ? deptRaw.trim() : null;

        jobs.push(
          new JobPostDto({
            id,
            site: Site.ALGOLIA,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'Algolia',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/algolia/jobs/${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            department,
          }),
        );
      }

      this.logger.log(`Algolia: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Algolia scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
