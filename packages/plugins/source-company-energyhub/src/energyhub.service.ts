import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * EnergyHub — DERMS platform for utilities to manage distributed energy resources.
 *
 * EnergyHub is a grid-edge energy technology company that provides a
 * distributed energy resource management system (DERMS) helping
 * utilities manage devices such as EV chargers, batteries, and smart
 * thermostats. Its Mercury platform aggregates these resources into
 * virtual power plants that utilities use to meet grid and market
 * objectives. EnergyHub is an independent subsidiary of Alarm.com
 * (Nasdaq: ALRM), which acquired it in 2013.
 *
 * Sector: Energy tech / Grid software (DERMS). HQ: Brooklyn, NY.
 *
 * Highlights:
 *   - Mercury DERMS platform aggregates EVs, batteries, and smart
 *     devices into virtual power plants
 *   - Works with over 60 North American utilities managing thousands
 *     of megawatts of flexible capacity
 *   - Independent subsidiary of Alarm.com (Nasdaq: ALRM) since 2013
 *
 * Source profile (Spec 622):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/energyhub/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'EnergyHub'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 21 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/energyhub/jobs';

@SourcePlugin({
  site: Site.ENERGYHUB,
  name: 'EnergyHub',
  category: 'company',
})
@Injectable()
export class EnergyHubService implements IScraper {
  private readonly logger = new Logger(EnergyHubService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`EnergyHub: fetching ${url}`);

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
        const id = `energyhub-${jobId}`;

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
            site: Site.ENERGYHUB,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'EnergyHub',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/energyhub/jobs/${listing.id}`,
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

      this.logger.log(`EnergyHub: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`EnergyHub scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
