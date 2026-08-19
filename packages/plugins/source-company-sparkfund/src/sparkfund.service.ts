import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Sparkfund — Deploys distributed energy resources to expand grid capacity.
 *
 * Sparkfund is a clean-energy company, founded in 2013 and
 * headquartered in Washington, DC, that helps utilities and businesses
 * plan, finance, deploy, and operate distributed energy resources such
 * as battery storage and energy-efficiency assets. Through its
 * Distributed Capacity Procurement model, it turns buildings and
 * on-site assets into grid resources, handling project management,
 * regulatory work, and financing. The company has deployed thousands
 * of projects across many U.S. states.
 *
 * Sector: Clean energy / distributed energy resources. HQ: Washington, DC.
 *
 * Highlights:
 *   - Operates a Distributed Capacity Procurement model that lets
 *     utilities plan, deploy, and dispatch distributed energy
 *     resources
 *   - Reports thousands of deployed projects across dozens of U.S.
 *     states and hundreds of megawatts of energized assets
 *   - Provides financing and turnkey deployment so businesses can
 *     adopt energy-efficient and storage equipment
 *
 * Source profile (Spec 633):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/sparkfund/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'Sparkfund'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 6 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/sparkfund/jobs';

@SourcePlugin({
  site: Site.SPARKFUND,
  name: 'Sparkfund',
  category: 'company',
})
@Injectable()
export class SparkfundService implements IScraper {
  private readonly logger = new Logger(SparkfundService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Sparkfund: fetching ${url}`);

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
        const id = `sparkfund-${jobId}`;

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
            site: Site.SPARKFUND,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'Sparkfund',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/sparkfund/jobs/${listing.id}`,
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

      this.logger.log(`Sparkfund: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Sparkfund scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
