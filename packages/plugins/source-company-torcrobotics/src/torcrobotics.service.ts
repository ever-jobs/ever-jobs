import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Torc Robotics — Torc Robotics develops autonomous driving software to bring self-driving long-haul freight trucks to commercial operation in the United States..
 *
 * Torc Robotics is an autonomous driving technology company building a
 * complete self-driving software stack (TorcOS) for the long-haul
 * trucking and freight industry. Founded in 2005 and headquartered in
 * Blacksburg, Virginia, Torc operates as an independent subsidiary of
 * Daimler Truck following its 2019 acquisition. The company runs road
 * testing and fleet operations across the U.S. Sun Belt freight
 * corridors and maintains engineering sites in Ann Arbor, Michigan,
 * Fort Worth, Texas, and other locations.
 *
 * Sector: Autonomous Vehicles / Self-Driving Trucking. HQ: Blacksburg, Virginia, USA.
 *
 * Highlights:
 *   - Independent subsidiary of Daimler Truck, the largest heavy-duty
 *     truck manufacturer in North America (acquired August 2019)
 *   - Headquartered in Blacksburg, Virginia, with operations in Ann
 *     Arbor MI, Fort Worth/Austin TX, Albuquerque NM, Montreal, and
 *     Stuttgart
 *   - Builds TorcOS, its autonomous driving software platform,
 *     initially targeting the Freightliner Cascadia in the U.S.
 *   - Conducts autonomous truck road testing across Virginia, New
 *     Mexico, Texas, and (as of 2026) Michigan public roads
 *   - Founded in 2005; partners with Virginia Tech Transportation
 *     Institute for closed-course testing and validation
 *
 * Source profile (Spec 800):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/torcrobotics/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'Torc Robotics'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 58 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/torcrobotics/jobs';

@SourcePlugin({
  site: Site.TORC_ROBOTICS,
  name: 'Torc Robotics',
  category: 'company',
})
@Injectable()
export class TorcRoboticsService implements IScraper {
  private readonly logger = new Logger(TorcRoboticsService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Torc Robotics: fetching ${url}`);

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
        const id = `torcrobotics-${jobId}`;

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
            site: Site.TORC_ROBOTICS,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'Torc Robotics',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/torcrobotics/jobs/${listing.id}`,
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

      this.logger.log(`Torc Robotics: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Torc Robotics scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
