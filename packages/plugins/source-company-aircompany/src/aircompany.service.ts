import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * AIR COMPANY — AIR COMPANY is a carbon-conversion technology firm that transforms captured CO2 and hydrogen into fully-formulated synthetic fuels and chemicals, including sustainable aviation fuel..
 *
 * AIR COMPANY (branded "AIRCO") is a carbon-conversion technology
 * company that uses its proprietary AIRMADE process to hydrogenate
 * waste CO2 with hydrogen, producing synthetic fuels and chemicals
 * such as sustainable aviation fuel (SAF), ethanol, methanol, and
 * rocket fuel. Founded in 2017 by Gregory Constantine (CEO) and
 * Stafford Sheehan (CTO), the company is headquartered in Brooklyn,
 * NY, and in May 2026 announced a manufacturing and integration
 * facility in New Britain, Pennsylvania, that consolidates R&D,
 * engineering, and production. The sample roles (Chemical
 * Research/Development/Engineering, Engineer I, Lab Technician) and
 * the New Britain, PA location match this New Britain campus.
 *
 * Sector: Climate Tech / Carbon Conversion & Synthetic Fuels. HQ: Brooklyn, New York, United States.
 *
 * Highlights:
 *   - Founded in 2017 by Gregory Constantine (CEO) and Stafford
 *     Sheehan, Ph.D. (CTO)
 *   - Proprietary AIRMADE technology converts CO2 + hydrogen into
 *     synthetic fuels and chemicals (SAF, ethanol, methanol, diesel,
 *     rocket fuel)
 *   - Headquartered in Brooklyn, NY; opened a New Britain,
 *     Pennsylvania manufacturing/integration hub announced May 2026
 *   - Partnerships and contracts include JetBlue, Virgin Atlantic,
 *     NASA, and the U.S. Department of Defense Defense Innovation Unit
 *   - Recognition includes XPRIZE Carbon Removal, TIME Best
 *     Inventions, and Fast Company World Changing Ideas
 *
 * Source profile (Spec 788):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/aircompany/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'AIR COMPANY'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 4 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/aircompany/jobs';

@SourcePlugin({
  site: Site.AIR_COMPANY,
  name: 'AIR COMPANY',
  category: 'company',
})
@Injectable()
export class AIRCOMPANYService implements IScraper {
  private readonly logger = new Logger(AIRCOMPANYService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`AIR COMPANY: fetching ${url}`);

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
        const id = `aircompany-${jobId}`;

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
            site: Site.AIR_COMPANY,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'AIR COMPANY',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/aircompany/jobs/${listing.id}`,
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

      this.logger.log(`AIR COMPANY: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`AIR COMPANY scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
