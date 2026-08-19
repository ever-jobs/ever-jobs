import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Banyan Infrastructure — Banyan Infrastructure provides a software platform that streamlines financing and management of renewable energy and sustainable infrastructure projects..
 *
 * Banyan Infrastructure is a San Francisco-based software company
 * offering a financing operating system for sustainable infrastructure
 * and renewable energy projects. Its platform helps lenders,
 * developers, and investors originate, manage, and monitor project
 * finance deals more efficiently. The company aims to unlock capital
 * flow toward decarbonization and climate infrastructure.
 *
 * Sector: Climate / Infrastructure fintech. HQ: San Francisco, USA.
 *
 * Highlights:
 *   - Financing operating system for renewable energy and sustainable
 *     infrastructure projects
 *   - Headquartered in San Francisco with roles spanning AI
 *     engineering, finance, and enterprise sales
 *   - Focused on accelerating capital deployment for climate and
 *     decarbonization infrastructure
 *
 * Source profile (Spec 681):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/banyaninfrastructure/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'Banyan Infrastructure'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 4 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/banyaninfrastructure/jobs';

@SourcePlugin({
  site: Site.BANYAN_INFRASTRUCTURE,
  name: 'Banyan Infrastructure',
  category: 'company',
})
@Injectable()
export class BanyanInfrastructureService implements IScraper {
  private readonly logger = new Logger(BanyanInfrastructureService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Banyan Infrastructure: fetching ${url}`);

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
        const id = `banyaninfrastructure-${jobId}`;

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
            site: Site.BANYAN_INFRASTRUCTURE,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'Banyan Infrastructure',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/banyaninfrastructure/jobs/${listing.id}`,
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

      this.logger.log(`Banyan Infrastructure: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Banyan Infrastructure scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
