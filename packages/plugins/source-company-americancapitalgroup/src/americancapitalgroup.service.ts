import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * American Capital Group — Bellevue-based real estate firm developing and building multifamily residential communities..
 *
 * American Capital Group is a privately owned, vertically integrated
 * real estate company based in Bellevue, Washington, focused on the
 * design, development, construction, and management of multifamily
 * residential communities. It operates an in-house construction arm
 * under the American Home Builders name and develops apartment
 * communities across western U.S. markets. Hiring signals point to
 * architecture, design, and construction project management roles in
 * the Pacific Northwest.
 *
 * Sector: Real Estate Development & Construction. HQ: Bellevue, WA, USA.
 *
 * Highlights:
 *   - Vertically integrated real estate company spanning design,
 *     development, construction, and property management
 *   - Operates an in-house construction division branded as American
 *     Home Builders
 *   - Focus on multifamily and apartment community development
 *   - Hiring architects and construction project managers in Bellevue,
 *     WA and Portland, OR
 *   - Dedicated in-house Design department
 *
 * Source profile (Spec 260):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/americancapitalgroup/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'American Capital Group'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 9 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/americancapitalgroup/jobs';

@SourcePlugin({
  site: Site.AMERICANCAPITALGROUP,
  name: 'American Capital Group',
  category: 'company',
})
@Injectable()
export class AmericancapitalgroupService implements IScraper {
  private readonly logger = new Logger(AmericancapitalgroupService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`American Capital Group: fetching ${url}`);

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
        const id = `americancapitalgroup-${jobId}`;

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
            site: Site.AMERICANCAPITALGROUP,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'American Capital Group',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/americancapitalgroup/jobs/${listing.id}`,
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

      this.logger.log(`American Capital Group: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`American Capital Group scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
