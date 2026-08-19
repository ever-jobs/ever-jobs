import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Cortica - Neurodevelopmental — Integrated clinical care for children with autism and neurodevelopmental conditions.
 *
 * Cortica is a healthcare provider delivering integrated,
 * multidisciplinary care for children with autism and other
 * neurodevelopmental conditions. Its whole-child model combines
 * applied behavior analysis (ABA), medical, occupational,
 * speech-language, and counseling therapies, delivered through
 * clinics, in-home visits, and telehealth across multiple U.S. states.
 * The company operates a network of regional clinics and recruits both
 * clinical staff (behavior technicians, BCBAs, occupational
 * therapists) and operations and administrative roles.
 *
 * Sector: Healthcare / Pediatric Neurodevelopmental Care. HQ: San Diego, CA, USA.
 *
 * Highlights:
 *   - Specializes in ABA therapy and behavioral intervention for
 *     children with autism and neurodevelopmental differences
 *   - Multidisciplinary teams span behavioral analysis, occupational
 *     therapy, and counseling under one care model
 *   - Operates clinics across multiple U.S. states including CA, MA,
 *     AZ, and NJ
 *   - Hires across clinical and operational functions, including
 *     paid-training behavior technician roles and BCBA supervisors
 *
 * Source profile (Spec 232):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/allcareers/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'Cortica - Neurodevelopmental'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 129 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/allcareers/jobs';

@SourcePlugin({
  site: Site.ALLCAREERS,
  name: 'Cortica - Neurodevelopmental',
  category: 'company',
})
@Injectable()
export class AllcareersService implements IScraper {
  private readonly logger = new Logger(AllcareersService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Cortica - Neurodevelopmental: fetching ${url}`);

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
        const id = `allcareers-${jobId}`;

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
            site: Site.ALLCAREERS,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'Cortica - Neurodevelopmental',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/allcareers/jobs/${listing.id}`,
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

      this.logger.log(`Cortica - Neurodevelopmental: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Cortica - Neurodevelopmental scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
