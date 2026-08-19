import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Cortica — Cortica operates pediatric medical centers delivering integrated whole-child care for autism and neurodevelopmental differences..
 *
 * Cortica is a U.S. healthcare provider that operates pediatric care
 * centers focused on children with autism and other neurodevelopmental
 * and behavioral conditions. It combines medical, developmental, and
 * behavioral services — including Applied Behavior Analysis (ABA)
 * therapy, neurology, speech, occupational, and physical therapy —
 * under a single coordinated care model. The company runs in-person
 * clinics across multiple U.S. states alongside in-home and telehealth
 * services. Its clinical workforce includes ABA clinical directors and
 * supervisors, therapists, and physicians.
 *
 * Sector: Healthcare / Pediatric Neurodevelopmental Care. HQ: San Diego, California, United States.
 *
 * Highlights:
 *   - Provides integrated, whole-child pediatric care for autism and
 *     neurodevelopmental conditions
 *   - Offers ABA therapy alongside neurology, speech, occupational,
 *     and physical therapy
 *   - Operates in-person care centers across multiple U.S. states
 *   - Clinical roles span ABA clinical directors, supervisors, and
 *     multidisciplinary therapists
 *   - Delivers care via clinics, in-home services, and telehealth
 *
 * Source profile (Spec 775):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/cortica/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'Cortica'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 66 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/cortica/jobs';

@SourcePlugin({
  site: Site.CORTICA,
  name: 'Cortica',
  category: 'company',
})
@Injectable()
export class CorticaService implements IScraper {
  private readonly logger = new Logger(CorticaService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Cortica: fetching ${url}`);

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
        const id = `cortica-${jobId}`;

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
            site: Site.CORTICA,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'Cortica',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/cortica/jobs/${listing.id}`,
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

      this.logger.log(`Cortica: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Cortica scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
