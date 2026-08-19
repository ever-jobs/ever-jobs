import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Komodo Health — Komodo Health is a healthcare technology company that builds a software platform powered by a large-scale map of patient encounters to deliver insights for life sciences, payers, and providers..
 *
 * Komodo Health is a healthcare technology company that combines
 * deidentified real-world patient data with enterprise software and AI
 * to surface clinical and commercial insights. Its core asset is the
 * Healthcare Map, a longitudinal view of patient journeys built from
 * billions of clinical and claims encounters across the United States.
 * The company sells SaaS applications and analytics used by
 * pharmaceutical and biotech firms, payers, providers, and patient
 * advocacy organizations. Komodo Health was founded in 2014 and serves
 * a primarily U.S. enterprise customer base.
 *
 * Sector: HealthTech / Healthcare Data & Analytics. HQ: San Francisco, California, United States.
 *
 * Highlights:
 *   - Healthcare data and analytics SaaS platform
 *   - Built around the longitudinal Healthcare Map of U.S. patient
 *     encounters
 *   - Founded 2014; headquartered in San Francisco, California
 *   - Serves life sciences, payers, and providers
 *   - Commercial sales roles concentrated in the United States
 *
 * Source profile (Spec 765):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/komodohealth/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'Komodo Health'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 36 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/komodohealth/jobs';

@SourcePlugin({
  site: Site.KOMODO_HEALTH,
  name: 'Komodo Health',
  category: 'company',
})
@Injectable()
export class KomodoHealthService implements IScraper {
  private readonly logger = new Logger(KomodoHealthService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Komodo Health: fetching ${url}`);

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
        const id = `komodohealth-${jobId}`;

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
            site: Site.KOMODO_HEALTH,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'Komodo Health',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/komodohealth/jobs/${listing.id}`,
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

      this.logger.log(`Komodo Health: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Komodo Health scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
