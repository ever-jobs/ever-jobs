import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Antora Energy — Thermal energy storage company converting renewable electricity into zero-carbon industrial heat and power..
 *
 * Antora Energy is a U.S. company developing thermal energy storage
 * and heat-and-power systems that store renewable electricity as heat
 * in solid carbon blocks to deliver zero-carbon industrial heat and
 * power. Hiring signals span manufacturing operations, product
 * development, commercial, and corporate functions, with a
 * headquarters in San Jose, California and manufacturing-related roles
 * tied to a facility in Big Stone City, South Dakota. Open roles such
 * as Electrical Engineering Manager, Buyer/Planner, and various
 * internships indicate a hardware- and operations-focused organization
 * scaling production.
 *
 * Sector: Clean energy / Thermal energy storage. HQ: San Jose, CA, USA.
 *
 * Highlights:
 *   - Builds thermal energy storage systems that store electricity as
 *     heat in solid carbon blocks
 *   - Headquartered in San Jose, CA with manufacturing activity in Big
 *     Stone City, SD
 *   - Hiring across manufacturing operations, product development,
 *     commercial, and finance
 *   - Hardware- and operations-oriented roles including engineering,
 *     planning, and internships
 *
 * Source profile (Spec 275):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/antora/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'Antora Energy'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 23 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/antora/jobs';

@SourcePlugin({
  site: Site.ANTORA,
  name: 'Antora Energy',
  category: 'company',
})
@Injectable()
export class AntoraService implements IScraper {
  private readonly logger = new Logger(AntoraService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Antora Energy: fetching ${url}`);

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
        const id = `antora-${jobId}`;

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
            site: Site.ANTORA,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'Antora Energy',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/antora/jobs/${listing.id}`,
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

      this.logger.log(`Antora Energy: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Antora Energy scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
