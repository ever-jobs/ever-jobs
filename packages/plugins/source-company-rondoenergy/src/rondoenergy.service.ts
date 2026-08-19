import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Rondo Energy — Rondo Energy develops thermal energy storage systems that convert renewable electricity into high-temperature heat to decarbonize industrial processes..
 *
 * Rondo Energy is a privately held energy technology company that
 * builds the Rondo Heat Battery, a thermal energy storage system that
 * uses renewable electricity to heat refractory brick and deliver
 * continuous high-temperature heat for industrial processes. The
 * company supplies industrial customers in sectors such as cement,
 * chemicals, food and beverage, and fuels, both as capital projects
 * and on a Heat-as-a-Service basis. Founded in the San Francisco Bay
 * Area, Rondo operates internationally, with deployments and offices
 * spanning Europe, the Middle East, and Asia.
 *
 * Sector: Industrial energy storage / clean tech. HQ: Oakland, California, United States.
 *
 * Highlights:
 *   - Develops the Rondo Heat Battery, a brick-based thermal storage
 *     system that stores renewable electricity as heat at temperatures
 *     up to roughly 1,500 degrees C
 *   - Targets industrial decarbonization across sectors including
 *     cement, chemicals, food and beverage, fuels, and textiles
 *   - Operates across multiple countries, with hiring for roles in
 *     Spain and the Middle East reflecting its international project
 *     delivery
 *
 * Source profile (Spec 661):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/rondoenergy/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'Rondo Energy'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 10 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/rondoenergy/jobs';

@SourcePlugin({
  site: Site.RONDO_ENERGY,
  name: 'Rondo Energy',
  category: 'company',
})
@Injectable()
export class RondoEnergyService implements IScraper {
  private readonly logger = new Logger(RondoEnergyService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Rondo Energy: fetching ${url}`);

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
        const id = `rondoenergy-${jobId}`;

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
            site: Site.RONDO_ENERGY,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'Rondo Energy',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/rondoenergy/jobs/${listing.id}`,
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

      this.logger.log(`Rondo Energy: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Rondo Energy scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
