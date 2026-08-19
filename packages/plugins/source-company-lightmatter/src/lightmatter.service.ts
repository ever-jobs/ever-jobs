import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Lightmatter — Lightmatter develops photonic computing and interconnect technology to accelerate AI and data-center workloads.
 *
 * Lightmatter is a semiconductor and computing company building
 * photonics-based hardware that uses light to move and process data
 * for artificial intelligence and high-performance data-center
 * applications. Its work spans optical interconnect and compute
 * technologies designed to improve the bandwidth and energy efficiency
 * of large-scale AI systems. The company maintains engineering teams
 * across the United States and Canada, including Boston, Mountain
 * View, and Toronto.
 *
 * Sector: Photonic computing. HQ: Mountain View, CA.
 *
 * Highlights:
 *   - Builds photonic computing and optical interconnect hardware for
 *     AI and data-center workloads
 *   - Hiring concentrated in analog and high-speed IC design roles
 *     across Boston, Mountain View, and Toronto
 *   - Operated a 44-role public Greenhouse careers board at time of
 *     capture
 *
 * Source profile (Spec 702):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/lightmatter/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'Lightmatter'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 44 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/lightmatter/jobs';

@SourcePlugin({
  site: Site.LIGHTMATTER,
  name: 'Lightmatter',
  category: 'company',
})
@Injectable()
export class LightmatterService implements IScraper {
  private readonly logger = new Logger(LightmatterService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Lightmatter: fetching ${url}`);

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
        const id = `lightmatter-${jobId}`;

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
            site: Site.LIGHTMATTER,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'Lightmatter',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/lightmatter/jobs/${listing.id}`,
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

      this.logger.log(`Lightmatter: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Lightmatter scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
