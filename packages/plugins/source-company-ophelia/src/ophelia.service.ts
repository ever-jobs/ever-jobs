import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Ophelia Health — Ophelia is a telehealth provider delivering medication-assisted treatment for opioid use disorder..
 *
 * Ophelia is a telemedicine company that provides at-home,
 * medication-assisted treatment (MAT) for opioid use disorder,
 * primarily using buprenorphine-based therapy combined with ongoing
 * clinical support. The service connects patients with licensed
 * clinicians, care navigators, and recovery specialists via virtual
 * visits, and operates across multiple U.S. states. Roles span
 * clinical operations, care navigation, and certified recovery
 * support, reflecting a care-delivery model centered on remote
 * addiction treatment.
 *
 * Sector: HealthTech / Telehealth (Addiction Treatment). HQ: New York, New York, United States.
 *
 * Highlights:
 *   - Sector: telehealth provider for opioid use disorder treatment
 *   - Care model: at-home medication-assisted treatment
 *     (buprenorphine)
 *   - Operates across multiple U.S. states including PA, NJ, NY, DE
 *   - Team includes clinicians, care navigators, and certified
 *     recovery specialists
 *   - HQ: New York, NY, United States
 *
 * Source profile (Spec 766):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/ophelia/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'Ophelia Health'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 19 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/ophelia/jobs';

@SourcePlugin({
  site: Site.OPHELIA_HEALTH,
  name: 'Ophelia Health',
  category: 'company',
})
@Injectable()
export class OpheliaHealthService implements IScraper {
  private readonly logger = new Logger(OpheliaHealthService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Ophelia Health: fetching ${url}`);

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
        const id = `ophelia-${jobId}`;

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
            site: Site.OPHELIA_HEALTH,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'Ophelia Health',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/ophelia/jobs/${listing.id}`,
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

      this.logger.log(`Ophelia Health: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Ophelia Health scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
