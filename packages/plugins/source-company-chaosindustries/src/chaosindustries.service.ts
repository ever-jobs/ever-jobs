import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * CHAOS Industries — Defense technology company building advanced sensing and electromagnetic systems for air defense and counter-drone (CUAS) missions..
 *
 * CHAOS Industries is a U.S. defense technology company developing
 * advanced sensing, electromagnetic, and detection systems for
 * national security applications. Its work spans air and missile
 * defense and counter-unmanned aircraft systems (CUAS), serving
 * military and government customers. The company is headquartered in
 * El Segundo, California, with a business and government-facing
 * presence in Washington, D.C. It hires across aerospace engineering,
 * hardware, and defense business development disciplines.
 *
 * Sector: Defense Tech / Aerospace. HQ: El Segundo, California, United States.
 *
 * Highlights:
 *   - Headquartered in El Segundo, California, with a Washington, D.C.
 *     presence for government and Army business development
 *   - Focuses on air and missile defense and counter-unmanned aircraft
 *     systems (CUAS)
 *   - Develops advanced sensing and electromagnetic detection
 *     technology for national security
 *   - Hires aerospace and defense talent including aerodynamics
 *     engineers and defense business development leads
 *   - Serves U.S. military and government customers
 *
 * Source profile (Spec 773):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/chaosindustries/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'CHAOS Industries'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 155 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/chaosindustries/jobs';

@SourcePlugin({
  site: Site.CHAOS_INDUSTRIES,
  name: 'CHAOS Industries',
  category: 'company',
})
@Injectable()
export class CHAOSIndustriesService implements IScraper {
  private readonly logger = new Logger(CHAOSIndustriesService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`CHAOS Industries: fetching ${url}`);

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
        const id = `chaosindustries-${jobId}`;

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
            site: Site.CHAOS_INDUSTRIES,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'CHAOS Industries',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/chaosindustries/jobs/${listing.id}`,
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

      this.logger.log(`CHAOS Industries: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`CHAOS Industries scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
