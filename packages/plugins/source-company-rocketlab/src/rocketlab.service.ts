import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Rocket Lab — Aerospace company building rockets and spacecraft for orbital launch.
 *
 * Rocket Lab is an aerospace manufacturer and launch services provider
 * that designs and builds rockets, satellites, and spacecraft
 * components. Its Electron small-lift rocket delivers payloads to
 * orbit, and the company is developing the larger Neutron launch
 * vehicle alongside its Photon spacecraft platform. Rocket Lab also
 * manufactures space systems hardware including solar cells, reaction
 * wheels, and satellite separation systems.
 *
 * Sector: Aerospace & launch. HQ: Long Beach, CA.
 *
 * Highlights:
 *   - Operates the Electron orbital launch vehicle and is developing
 *     the larger Neutron rocket
 *   - Produces spacecraft and space systems components, including its
 *     Photon satellite bus
 *   - Maintains rocket manufacturing and launch operations across the
 *     United States and New Zealand
 *
 * Source profile (Spec 630):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/rocketlab/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'Rocket Lab'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 310 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/rocketlab/jobs';

@SourcePlugin({
  site: Site.ROCKET_LAB,
  name: 'Rocket Lab',
  category: 'company',
})
@Injectable()
export class RocketLabService implements IScraper {
  private readonly logger = new Logger(RocketLabService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Rocket Lab: fetching ${url}`);

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
        const id = `rocketlab-${jobId}`;

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
            site: Site.ROCKET_LAB,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'Rocket Lab',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/rocketlab/jobs/${listing.id}`,
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

      this.logger.log(`Rocket Lab: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Rocket Lab scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
