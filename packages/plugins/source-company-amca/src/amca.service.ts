import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Amca — Aerospace and defense company building critical components for America's industrial base..
 *
 * Amca is an aerospace and defense industrial company based in El
 * Segundo, California, focused on manufacturing critical components
 * and expanding supply-chain capacity for the U.S. industrial base. It
 * develops and produces mission-critical aerospace hardware and parts,
 * positioning itself around open competition and faster delivery of
 * essential components. Hiring signals span engineering, an in-house
 * Protoshop for prototyping and assembly, business operations,
 * finance, growth, and legal functions, with a second site in
 * Setauket, New York.
 *
 * Sector: Aerospace & Defense Manufacturing. HQ: El Segundo, CA, USA.
 *
 * Highlights:
 *   - Designs and manufactures critical aerospace and defense
 *     components and hardware
 *   - Operates an in-house Protoshop for prototyping, assembly, and
 *     testing
 *   - Headquartered in El Segundo, CA, with an additional site in
 *     Setauket, New York
 *   - Hiring across Engineering, Business Operations, Finance, Growth,
 *     and Legal
 *   - Positions itself around open competition and faster delivery of
 *     supply-chain-critical parts
 *
 * Source profile (Spec 258):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/amca/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'Amca'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 28 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/amca/jobs';

@SourcePlugin({
  site: Site.AMCA,
  name: 'Amca',
  category: 'company',
})
@Injectable()
export class AmcaService implements IScraper {
  private readonly logger = new Logger(AmcaService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Amca: fetching ${url}`);

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
        const id = `amca-${jobId}`;

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
            site: Site.AMCA,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'Amca',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/amca/jobs/${listing.id}`,
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

      this.logger.log(`Amca: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Amca scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
