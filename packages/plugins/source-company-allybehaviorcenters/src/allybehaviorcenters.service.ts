import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Ally Behavior Centers — Center-based ABA therapy provider for children with autism, with BCBA-led clinics across Maryland and Texas..
 *
 * Ally Behavior Centers is a provider of Applied Behavior Analysis
 * (ABA) therapy for children with autism, operating center-based
 * programs staffed by Board Certified Behavior Analysts (BCBAs) and
 * behavior technicians. Its hiring is concentrated in Maryland, with
 * multiple center locations including Frederick, Woodlawn, Baltimore,
 * White Marsh, and Odenton, and an additional presence in Austin,
 * Texas. Open roles emphasize clinical supervision positions such as
 * ABA Clinical Supervisor (BCBA).
 *
 * Sector: Healthcare / Autism & ABA Therapy Services. HQ: Maryland, USA.
 *
 * Highlights:
 *   - Specializes in Applied Behavior Analysis (ABA) therapy for
 *     children with autism
 *   - Operates center-based clinics staffed by Board Certified
 *     Behavior Analysts (BCBAs)
 *   - Multiple Maryland locations: Frederick, Woodlawn, Baltimore,
 *     White Marsh, and Odenton
 *   - Additional location in Austin, Texas
 *   - Recurring openings for ABA Clinical Supervisor (BCBA) roles
 *
 * Source profile (Spec 238):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/allybehaviorcenters/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'Ally Behavior Centers'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 271 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/allybehaviorcenters/jobs';

@SourcePlugin({
  site: Site.ALLYBEHAVIORCENTERS,
  name: 'Ally Behavior Centers',
  category: 'company',
})
@Injectable()
export class AllybehaviorcentersService implements IScraper {
  private readonly logger = new Logger(AllybehaviorcentersService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Ally Behavior Centers: fetching ${url}`);

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
        const id = `allybehaviorcenters-${jobId}`;

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
            site: Site.ALLYBEHAVIORCENTERS,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'Ally Behavior Centers',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/allybehaviorcenters/jobs/${listing.id}`,
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

      this.logger.log(`Ally Behavior Centers: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Ally Behavior Centers scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
