import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * AEC — Louisville-based commercial HVAC manufacturer representative and service provider.
 *
 * Air Equipment Company (AEC) is an HVAC manufacturer representative
 * and service provider based in Louisville, Kentucky, with additional
 * offices in Lexington, Kentucky and Evansville, Indiana. The company
 * represents equipment from manufacturers such as AAON and JCI/York
 * and provides commercial HVAC system design, sales engineering,
 * controls, and field service. Hiring spans technical service, sales
 * engineering, and operations functions. In 2024, AEC entered an
 * agreement to be acquired by Meriton while continuing to operate
 * under its own name.
 *
 * Sector: HVAC / Building Equipment Distribution. HQ: Louisville, Kentucky, USA.
 *
 * Highlights:
 *   - Founded roughly 75 years ago; represents 45+ HVAC manufacturers
 *     including AAON and JCI/York
 *   - Headquartered in Louisville, KY with offices in Lexington, KY
 *     and Evansville, IN
 *   - Hires across commercial HVAC technical service, controls, and
 *     outside sales engineering roles
 *   - Operates a Hydronics Division alongside equipment representation
 *     and field service
 *   - Entered an agreement to be acquired by Meriton (announced 2024),
 *     retaining its AEC name
 *
 * Source profile (Spec 195):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/aec/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'AEC'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 12 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/aec/jobs';

@SourcePlugin({
  site: Site.AEC,
  name: 'AEC',
  category: 'company',
})
@Injectable()
export class AecService implements IScraper {
  private readonly logger = new Logger(AecService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`AEC: fetching ${url}`);

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
        const id = `aec-${jobId}`;

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
            site: Site.AEC,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'AEC',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/aec/jobs/${listing.id}`,
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

      this.logger.log(`AEC: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`AEC scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
