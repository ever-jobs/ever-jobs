import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * AWL — Insurance customer-acquisition marketing company connecting consumers with licensed agents and carriers..
 *
 * AWL (All Web Leads) is a U.S. customer-acquisition marketing company
 * serving the insurance industry, founded in 2005 and headquartered in
 * Austin, Texas. It connects consumers shopping for insurance with
 * licensed agents, brokers, and carriers across auto, home, health,
 * life, and senior/Medicare lines, and operates an in-house contact
 * center and insurance agency. Hiring spans contact center, insurance
 * sales, and technology roles, with locations in Austin and Houston,
 * Texas.
 *
 * Sector: Insurance lead generation / marketing technology. HQ: Austin, Texas, USA.
 *
 * Highlights:
 *   - Founded in 2005; headquartered in Austin, Texas, with operations
 *     also in Houston
 *   - Generates and sells insurance leads across auto, home, health,
 *     life, and senior/Medicare lines
 *   - Operates an in-house contact center that connects consumers to
 *     licensed agents by phone
 *   - Runs an insurance agency arm in addition to its lead-generation
 *     business
 *   - Hiring spans contact center, insurance sales, and technology
 *     functions
 *
 * Source profile (Spec 237):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/allwebleads/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'AWL'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 6 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/allwebleads/jobs';

@SourcePlugin({
  site: Site.ALLWEBLEADS,
  name: 'AWL',
  category: 'company',
})
@Injectable()
export class AllwebleadsService implements IScraper {
  private readonly logger = new Logger(AllwebleadsService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`AWL: fetching ${url}`);

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
        const id = `allwebleads-${jobId}`;

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
            site: Site.ALLWEBLEADS,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'AWL',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/allwebleads/jobs/${listing.id}`,
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

      this.logger.log(`AWL: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`AWL scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
