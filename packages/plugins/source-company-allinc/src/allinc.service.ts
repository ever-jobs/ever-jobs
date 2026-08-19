import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Aspire Living & Learning  — Nonprofit human-services and education organization supporting neurodiverse children and adults.
 *
 * Aspire Living & Learning is a private, nonprofit human-services and
 * educational organization founded in 1981 that supports neurodiverse
 * children and adults, including people with intellectual and
 * developmental disabilities. Its programs span residential and adult
 * services, children's and clinical services (such as Applied Behavior
 * Analysis, behavior therapy, and assistive technology), and a school
 * known as ALL Academy. The organization operates across multiple
 * Northeast and Mid-Atlantic states, with roles seen in Connecticut,
 * Massachusetts, Maryland, and New Hampshire.
 *
 * Sector: Human Services / Disability Support & Education. HQ: Barre, Vermont, USA.
 *
 * Highlights:
 *   - Nonprofit founded in 1981 serving people with intellectual and
 *     developmental disabilities
 *   - Clinical services include Applied Behavior Analysis (ABA),
 *     behavior therapy, and assistive technology
 *   - Operates adult, children's, and clinical services plus a school
 *     (ALL Academy)
 *   - Multi-state footprint across CT, MA, MD, and NH
 *
 * Source profile (Spec 236):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/allinc/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'Aspire Living & Learning '`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 46 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/allinc/jobs';

@SourcePlugin({
  site: Site.ALLINC,
  name: 'Aspire Living & Learning ',
  category: 'company',
})
@Injectable()
export class AllincService implements IScraper {
  private readonly logger = new Logger(AllincService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Aspire Living & Learning : fetching ${url}`);

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
        const id = `allinc-${jobId}`;

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
            site: Site.ALLINC,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'Aspire Living & Learning ',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/allinc/jobs/${listing.id}`,
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

      this.logger.log(`Aspire Living & Learning : scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Aspire Living & Learning  scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
