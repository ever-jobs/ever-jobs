import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Formic — Formic provides industrial automation to manufacturers via a pay-per-hour Robots-as-a-Service model, with no upfront capital cost..
 *
 * Formic is a Chicago-based automation company that deploys industrial
 * robots and automation systems for manufacturers under a
 * Robots-as-a-Service (RaaS) model. Rather than selling equipment
 * outright, Formic offers automation on a usage-based, pay-per-hour
 * basis, covering installation, integration, monitoring, and
 * maintenance. Its solutions target repetitive manufacturing tasks
 * such as palletizing, machine tending, and packaging to help
 * producers address labor shortages and improve throughput.
 *
 * Sector: Robotics / Manufacturing Automation. HQ: Chicago, Illinois, USA.
 *
 * Highlights:
 *   - Robots-as-a-Service (RaaS) model with pay-per-hour pricing and
 *     no upfront capital outlay
 *   - Focuses on industrial and manufacturing automation tasks like
 *     palletizing, machine tending, and packaging
 *   - Bundles installation, integration, monitoring, and ongoing
 *     maintenance into the service
 *   - Headquartered in Chicago, Illinois
 *   - Targets manufacturers facing labor shortages and seeking higher
 *     production throughput
 *
 * Source profile (Spec 779):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/formic/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'Formic'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 31 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/formic/jobs';

@SourcePlugin({
  site: Site.FORMIC,
  name: 'Formic',
  category: 'company',
})
@Injectable()
export class FormicService implements IScraper {
  private readonly logger = new Logger(FormicService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Formic: fetching ${url}`);

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
        const id = `formic-${jobId}`;

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
            site: Site.FORMIC,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'Formic',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/formic/jobs/${listing.id}`,
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

      this.logger.log(`Formic: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Formic scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
