import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * AMAROK — Commercial perimeter security provider combining electric fencing with cameras, lighting, and alarms..
 *
 * AMAROK is a commercial perimeter security company headquartered in
 * Columbia, South Carolina, serving customers across the United
 * States. It provides electric fencing combined with surveillance
 * technology such as cameras, lighting, and alarms, offered through a
 * monthly subscription rather than upfront purchase. The company was
 * formerly known as Electric Guard Dog. Its hiring spans inside and
 * outside sales, enterprise accounts, field service, and 1099
 * construction subcontractors used to install fencing nationwide.
 *
 * Sector: Physical Security / Commercial Security Services. HQ: Columbia, South Carolina, USA.
 *
 * Highlights:
 *   - Specializes in electric perimeter fencing plus surveillance
 *     (cameras, lights, alarms) for commercial sites
 *   - Subscription/monthly-service model rather than upfront equipment
 *     purchase
 *   - Formerly branded as Electric Guard Dog
 *   - Nationwide U.S. footprint with field service and 1099
 *     construction subcontractors for installation
 *   - Sales-heavy hiring: inside sales, outside sales, and enterprise
 *     accounts
 *
 * Source profile (Spec 256):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/amarok/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'AMAROK'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 18 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/amarok/jobs';

@SourcePlugin({
  site: Site.AMAROK,
  name: 'AMAROK',
  category: 'company',
})
@Injectable()
export class AmarokService implements IScraper {
  private readonly logger = new Logger(AmarokService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`AMAROK: fetching ${url}`);

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
        const id = `amarok-${jobId}`;

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
            site: Site.AMAROK,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'AMAROK',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/amarok/jobs/${listing.id}`,
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

      this.logger.log(`AMAROK: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`AMAROK scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
