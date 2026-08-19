import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Faraday Future — Faraday Future is an American electric vehicle company developing luxury EVs and embodied-AI robotics..
 *
 * Faraday Future Intelligent Electric Inc. (NASDAQ: FFAI) is an
 * American electric-vehicle manufacturer founded in 2014 and
 * headquartered in El Segundo, California. Its flagship is the
 * ultra-luxury FF 91 electric vehicle, and it has launched a
 * lower-priced second brand, Faraday X (FX), centered on the FX Super
 * One. The company has more recently expanded into embodied-AI ("EAI")
 * robotics. The El Segundo location and roles spanning AI corporate
 * strategy and standard corporate functions like accounting match this
 * company.
 *
 * Sector: Automotive / Electric Vehicles. HQ: El Segundo, California, United States.
 *
 * Highlights:
 *   - Founded in 2014; headquartered in El Segundo, California
 *   - Publicly traded on NASDAQ under the ticker FFAI
 *   - Flagship product is the ultra-luxury FF 91 electric vehicle,
 *     with deliveries beginning in 2023
 *   - Launched a lower-priced second brand, Faraday X (FX), built
 *     around the FX Super One MPV
 *   - Expanded into embodied-AI (EAI) robotics in early 2026
 *
 * Source profile (Spec 792):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/faradayfuture/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'Faraday Future'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 62 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/faradayfuture/jobs';

@SourcePlugin({
  site: Site.FARADAY_FUTURE,
  name: 'Faraday Future',
  category: 'company',
})
@Injectable()
export class FaradayFutureService implements IScraper {
  private readonly logger = new Logger(FaradayFutureService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Faraday Future: fetching ${url}`);

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
        const id = `faradayfuture-${jobId}`;

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
            site: Site.FARADAY_FUTURE,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'Faraday Future',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/faradayfuture/jobs/${listing.id}`,
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

      this.logger.log(`Faraday Future: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Faraday Future scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
