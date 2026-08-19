import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Airspace  — Technology-enabled logistics company focused on time-critical, expedited shipping.
 *
 * Airspace (Airspace Technologies) is a technology-enabled logistics
 * company specializing in time-critical and expedited shipping,
 * headquartered in Carlsbad, California. Its platform combines
 * software-driven routing, tracking, and shipment yield management
 * with a network of drivers and air/ground carriers to move urgent
 * freight. Hiring signals point to industry verticals such as medical
 * device and industrials, plus product, operations, and
 * revenue-operations functions across North American and European
 * hubs.
 *
 * Sector: Logistics & Supply Chain Technology. HQ: Carlsbad, CA, US.
 *
 * Highlights:
 *   - Time-critical and expedited freight delivery as the core service
 *   - Tech platform spanning product/R&D, integrations, and shipment
 *     yield management
 *   - In-house driver operations alongside air and ground carrier
 *     networks
 *   - Industry verticals including medical device and industrials
 *   - Operational footprint across North America (incl. Anchorage, AK;
 *     Des Plaines, IL) and Europe
 *
 * Source profile (Spec 217):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/airspace/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'Airspace '`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 11 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/airspace/jobs';

@SourcePlugin({
  site: Site.AIRSPACE,
  name: 'Airspace ',
  category: 'company',
})
@Injectable()
export class AirspaceService implements IScraper {
  private readonly logger = new Logger(AirspaceService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Airspace : fetching ${url}`);

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
        const id = `airspace-${jobId}`;

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
            site: Site.AIRSPACE,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'Airspace ',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/airspace/jobs/${listing.id}`,
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

      this.logger.log(`Airspace : scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Airspace  scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
