import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Advanced Space — Aerospace company focused on spacecraft navigation, mission design, and cislunar flight operations.
 *
 * Advanced Space is an aerospace company specializing in mission
 * design, spacecraft navigation, and flight software for space
 * missions, with a particular focus on cislunar and deep-space
 * operations. The company is known for leading NASA's CAPSTONE
 * mission, the first commercially operated spacecraft to fly in a
 * near-rectilinear halo orbit at the Moon, and for developing
 * autonomous spacecraft navigation technology. Hiring signals show it
 * staffs navigation engineering roles alongside infrastructure and
 * facility-security functions out of Westminster, Colorado.
 *
 * Sector: Aerospace. HQ: Westminster, Colorado, USA.
 *
 * Highlights:
 *   - Specializes in spacecraft navigation, mission design, and flight
 *     software
 *   - Led NASA's CAPSTONE mission, the first commercial spacecraft to
 *     operate at the Moon
 *   - Developed autonomous spacecraft navigation technology (CAPS) for
 *     cislunar operations
 *   - Hires across Navigation and Infrastructure & Security functions,
 *     including a Facility Security Officer (signaling
 *     cleared/government work)
 *   - Headquartered in Westminster, Colorado
 *
 * Source profile (Spec 192):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/advancedspace/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'Advanced Space'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 5 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/advancedspace/jobs';

@SourcePlugin({
  site: Site.ADVANCEDSPACE,
  name: 'Advanced Space',
  category: 'company',
})
@Injectable()
export class AdvancedspaceService implements IScraper {
  private readonly logger = new Logger(AdvancedspaceService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Advanced Space: fetching ${url}`);

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
        const id = `advancedspace-${jobId}`;

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
            site: Site.ADVANCEDSPACE,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'Advanced Space',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/advancedspace/jobs/${listing.id}`,
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

      this.logger.log(`Advanced Space: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Advanced Space scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
