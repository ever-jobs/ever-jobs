import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Via — Via builds AI-powered software and technology-enabled operations that power public transit and mobility networks for cities, transit agencies, and school districts worldwide..
 *
 * Via Transportation, Inc. is a transit technology ("TransitTech")
 * company that provides AI-powered software-as-a-service and
 * full-service operations to run more efficient, equitable public
 * transportation systems. Its platform spans fixed-route bus,
 * microtransit, paratransit, student/school transportation, and
 * autonomous-vehicle operations for cities, transit agencies, school
 * districts, universities, and corporations. Founded in 2012 by Daniel
 * Ramot and Oren Shoval, the company is headquartered in New York City
 * with major hubs in Tel Aviv and London. Via went public on the New
 * York Stock Exchange under the ticker VIA.
 *
 * Sector: TransitTech / Mobility Software (SaaS + Operations). HQ: New York City, New York, USA.
 *
 * Highlights:
 *   - Founded in 2012 by Daniel Ramot and Oren Shoval; headquartered
 *     in New York City with major engineering hubs in Tel Aviv and
 *     London
 *   - Platform covers fixed-route bus, microtransit, paratransit,
 *     student transportation, and autonomous-vehicle operations
 *   - Serves 700+ partner organizations including cities, transit
 *     agencies, school districts, universities, and corporations
 *     globally
 *   - Publicly traded on the New York Stock Exchange under ticker VIA
 *   - Board roles span Engineering, Operations, Expansion/Finance,
 *     Marketing (incl. ABM), and regional enterprise Sales (Account
 *     Directors across US regions), consistent with
 *     NYC/Remote/US-region locations
 *
 * Source profile (Spec 802):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/via/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'Via'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 165 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/via/jobs';

@SourcePlugin({
  site: Site.VIA,
  name: 'Via',
  category: 'company',
})
@Injectable()
export class ViaService implements IScraper {
  private readonly logger = new Logger(ViaService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Via: fetching ${url}`);

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
        const id = `via-${jobId}`;

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
            site: Site.VIA,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'Via',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/via/jobs/${listing.id}`,
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

      this.logger.log(`Via: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Via scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
