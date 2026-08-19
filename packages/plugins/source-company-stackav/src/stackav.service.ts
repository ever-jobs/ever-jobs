import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Stack AV — Stack AV develops AI-powered autonomous driving technology for long-haul trucking to improve safety, uptime, and efficiency in freight transportation..
 *
 * Stack AV is an autonomous trucking company building AI and advanced
 * self-driving systems for commercial freight, aiming to address
 * driver shortages, vehicle uptime, roadway safety, operating costs,
 * and emissions. It was founded in 2023 by Bryan Salesky (CEO), Peter
 * Rander (President), and Brett Browning (CTO), the former leadership
 * of Argo AI. The company is backed by SoftBank Group and operates
 * with employees across Pennsylvania and many other US states. Its
 * careers board lists autonomous-trucking operations roles such as
 * mission control dispatchers and CDL Class A operations specialists
 * across hubs including Pittsburgh, Atlanta, and Denver.
 *
 * Sector: Autonomous Vehicles / Self-Driving Trucking. HQ: Pittsburgh, Pennsylvania, USA.
 *
 * Highlights:
 *   - Founded in 2023 by former Argo AI leaders Bryan Salesky, Peter
 *     Rander, and Brett Browning
 *   - Headquartered in Pittsburgh, Pennsylvania
 *   - Backed by SoftBank Group
 *   - Develops AI-powered autonomous systems for long-haul trucking
 *   - Operates across multiple US locations including Pittsburgh,
 *     Atlanta, and Denver
 *
 * Source profile (Spec 798):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/stackav/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'Stack AV'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 22 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/stackav/jobs';

@SourcePlugin({
  site: Site.STACK_AV,
  name: 'Stack AV',
  category: 'company',
})
@Injectable()
export class StackAVService implements IScraper {
  private readonly logger = new Logger(StackAVService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Stack AV: fetching ${url}`);

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
        const id = `stackav-${jobId}`;

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
            site: Site.STACK_AV,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'Stack AV',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/stackav/jobs/${listing.id}`,
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

      this.logger.log(`Stack AV: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Stack AV scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
