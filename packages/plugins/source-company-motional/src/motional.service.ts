import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Motional — Autonomous vehicle technology company developing driverless systems for ride-hail and delivery.
 *
 * Motional is an American autonomous vehicle company that develops and
 * commercializes driverless technology, including the hardware,
 * software, and machine learning systems that enable vehicles to
 * operate without a human driver. Founded in 2020 as a joint venture
 * between Hyundai Motor Group and Aptiv, the company designs SAE Level
 * 4 self-driving systems for applications such as robotaxi
 * ride-hailing and autonomous delivery. Motional conducts public-road
 * testing and operations across multiple U.S. cities and maintains
 * engineering and operational sites internationally.
 *
 * Sector: Autonomous Vehicles / Robotics. HQ: Boston, Massachusetts, USA.
 *
 * Highlights:
 *   - Founded in 2020 as a Hyundai Motor Group and Aptiv joint venture
 *   - Develops SAE Level 4 driverless technology
 *   - Headquartered in Boston with sites in Pittsburgh, Las Vegas,
 *     Santa Monica, Singapore, and Seoul
 *   - Builds full-stack AV hardware, software, and ML driving systems
 *   - Targets robotaxi ride-hail and autonomous delivery use cases
 *
 * Source profile (Spec 748):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/motional/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'Motional'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 103 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/motional/jobs';

@SourcePlugin({
  site: Site.MOTIONAL,
  name: 'Motional',
  category: 'company',
})
@Injectable()
export class MotionalService implements IScraper {
  private readonly logger = new Logger(MotionalService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Motional: fetching ${url}`);

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
        const id = `motional-${jobId}`;

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
            site: Site.MOTIONAL,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'Motional',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/motional/jobs/${listing.id}`,
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

      this.logger.log(`Motional: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Motional scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
