import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Apaleo — API-first property management platform for hotels and serviced apartments.
 *
 * Apaleo is a German software company that develops an API-first
 * property management platform for hotels, serviced apartments, and
 * other hospitality businesses. Its platform combines core property
 * management functionality with an open app marketplace, letting
 * operators connect third-party tools rather than rely on a single
 * all-in-one suite. Hiring across sales (DACH), platform success and
 * onboarding, engineering, and marketing reflects a B2B SaaS company
 * serving hospitality operators.
 *
 * Sector: Hospitality SaaS / Property Management Software. HQ: Munich, Germany.
 *
 * Highlights:
 *   - API-first, open property management platform for hospitality,
 *     with an app marketplace for third-party integrations
 *   - Headquartered in Munich, with hiring also seen in Berlin and
 *     remote roles
 *   - Serves hotels, serviced apartments, and hospitality brands as a
 *     B2B SaaS provider
 *   - Roles span DACH sales, platform success and onboarding,
 *     engineering, marketing, and people & culture
 *
 * Source profile (Spec 277):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/apaleo/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'Apaleo'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 9 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/apaleo/jobs';

@SourcePlugin({
  site: Site.APALEO,
  name: 'Apaleo',
  category: 'company',
})
@Injectable()
export class ApaleoService implements IScraper {
  private readonly logger = new Logger(ApaleoService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Apaleo: fetching ${url}`);

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
        const id = `apaleo-${jobId}`;

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
            site: Site.APALEO,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'Apaleo',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/apaleo/jobs/${listing.id}`,
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

      this.logger.log(`Apaleo: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Apaleo scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
