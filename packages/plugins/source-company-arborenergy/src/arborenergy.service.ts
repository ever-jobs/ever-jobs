import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Arbor Energy — Arbor Energy builds baseload power systems that generate carbon-negative electricity by combusting biomass-derived fuel in high-pressure oxy-combustion turbomachinery and permanently sequestering the captured CO2..
 *
 * Arbor Energy (arbor.co) is a climate-tech company developing a
 * scalable, low-cost approach to Bioenergy with Carbon Capture and
 * Storage (BECCS) using technology derived from modern rocket engines.
 * Its system gasifies biomass and combusts the resulting fuel with
 * pure oxygen in a high-pressure cycle, producing baseload electricity
 * while capturing CO2 for permanent geologic storage. The company is
 * headquartered in El Segundo, California, with additional
 * hardware/test operations in San Bernardino, and its engineering
 * roles center on combustion, turbomachinery, heat transfer, and
 * high-pressure-gas testing. Note: this is the power/carbon-removal
 * startup, distinct from other businesses sharing the "Arbor" name.
 *
 * Sector: Climate Tech / Carbon-Negative Power (BECCS). HQ: El Segundo, California, USA.
 *
 * Highlights:
 *   - Develops carbon-negative baseload power via BECCS using
 *     rocket-engine-derived oxy-combustion technology
 *   - Headquartered in El Segundo, CA with hardware and test
 *     operations in San Bernardino, CA
 *   - Engineering focus spans combustion analysis, turbomachinery,
 *     heat transfer, and high-pressure-gas testing
 *   - Roles are on-site, reflecting the deep hardware-engineering
 *     nature of the work
 *   - Operates both a Greenhouse and a Lever careers presence under
 *     the 'arborenergy' identifier
 *
 * Source profile (Spec 789):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/arborenergy/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'Arbor Energy'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 19 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/arborenergy/jobs';

@SourcePlugin({
  site: Site.ARBOR_ENERGY,
  name: 'Arbor Energy',
  category: 'company',
})
@Injectable()
export class ArborEnergyService implements IScraper {
  private readonly logger = new Logger(ArborEnergyService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Arbor Energy: fetching ${url}`);

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
        const id = `arborenergy-${jobId}`;

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
            site: Site.ARBOR_ENERGY,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'Arbor Energy',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/arborenergy/jobs/${listing.id}`,
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

      this.logger.log(`Arbor Energy: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Arbor Energy scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
