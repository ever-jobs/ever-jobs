import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Albedo — Very low Earth orbit satellites for high-resolution Earth imaging..
 *
 * Albedo (Albedo Space) is an aerospace company based in Broomfield,
 * Colorado, that designs and operates satellites in very low Earth
 * orbit (VLEO) to capture high-resolution Earth imagery. Its hiring
 * spans guidance, navigation and control, opto-mechanical, electrical,
 * and software engineering, reflecting in-house development of
 * satellite hardware and imaging systems. The company serves
 * commercial and government/defense customers, including U.S. national
 * security and reconnaissance contracts.
 *
 * Sector: Aerospace / Satellite Earth Observation. HQ: Broomfield, CO, USA.
 *
 * Highlights:
 *   - Operates very low Earth orbit (VLEO) satellites for
 *     high-resolution Earth observation imagery
 *   - Engineering org spans guidance, navigation & control,
 *     opto-mechanical, electrical, and software disciplines
 *   - Serves commercial and government/defense customers, including
 *     U.S. reconnaissance and Air Force contracts
 *   - Headquartered in Broomfield, Colorado, with hardware and
 *     software developed in-house
 *   - Hiring senior leadership (Director of Hardware, Director of
 *     Software) and GNSS navigation/estimation engineers
 *
 * Source profile (Spec 227):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/albedo/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'Albedo'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 9 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/albedo/jobs';

@SourcePlugin({
  site: Site.ALBEDO,
  name: 'Albedo',
  category: 'company',
})
@Injectable()
export class AlbedoService implements IScraper {
  private readonly logger = new Logger(AlbedoService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Albedo: fetching ${url}`);

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
        const id = `albedo-${jobId}`;

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
            site: Site.ALBEDO,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'Albedo',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/albedo/jobs/${listing.id}`,
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

      this.logger.log(`Albedo: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Albedo scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
