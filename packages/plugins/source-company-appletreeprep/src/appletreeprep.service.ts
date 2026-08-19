import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * AppleTree Prep — Georgia early-childhood education provider running multiple child care centers from infant care through Pre-K..
 *
 * AppleTree Prep is a Georgia-based child care and early education
 * provider operating multiple centers in the Athens area and beyond,
 * including Watkinsville, Athens, Bogart, Loganville, and Macon. It
 * serves children from infancy through school age with programs
 * spanning all-day care, Georgia Lottery-funded Pre-K, after-school
 * care, and summer camp. Several of its centers hold a three-star
 * Quality Rated accreditation through Georgia's state program. Hiring
 * spans classroom roles such as infant teachers as well as center
 * leadership positions like assistant director.
 *
 * Sector: Early Childhood Education / Child Care. HQ: Watkinsville, Georgia, USA.
 *
 * Highlights:
 *   - Operates multiple centers across Georgia (Watkinsville, Athens,
 *     Bogart, Loganville, Macon)
 *   - Serves children from infancy through school age (roughly 6 weeks
 *     to 12 years)
 *   - Programs include all-day care, Georgia Lottery-funded Pre-K,
 *     after-school, and summer camp
 *   - Several centers hold a three-star Quality Rated accreditation in
 *     Georgia
 *   - Hires both teaching staff (e.g., infant teachers) and center
 *     leadership (assistant directors)
 *
 * Source profile (Spec 294):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/appletreeprep/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'AppleTree Prep'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 13 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/appletreeprep/jobs';

@SourcePlugin({
  site: Site.APPLETREEPREP,
  name: 'AppleTree Prep',
  category: 'company',
})
@Injectable()
export class AppletreeprepService implements IScraper {
  private readonly logger = new Logger(AppletreeprepService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`AppleTree Prep: fetching ${url}`);

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
        const id = `appletreeprep-${jobId}`;

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
            site: Site.APPLETREEPREP,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'AppleTree Prep',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/appletreeprep/jobs/${listing.id}`,
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

      this.logger.log(`AppleTree Prep: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`AppleTree Prep scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
