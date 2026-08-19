import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * C3 AI — C3 AI is an employer in the Enterprise applied AI applications sector, headquartered in Redwood City, California, USA..
 *
 * C3 AI is a company operating in Enterprise applied AI applications,
 * headquartered in Redwood City, California, USA. This source plugin
 * ingests live open roles published on C3 AI's official
 * Greenhouse-hosted careers board via the public Greenhouse Job Board
 * API. Retrieved postings are normalized into the Ever Jobs job schema
 * so they can flow through the standard sourcing pipeline
 * (deduplication, liveness checking, and salary normalization). The
 * plugin performs read-only, unauthenticated discovery and stores no
 * candidate or employer credentials.
 *
 * Sector: Enterprise applied AI applications. HQ: Redwood City, California, USA.
 *
 * Highlights:
 *   - Sector: Enterprise applied AI applications
 *   - Headquarters: Redwood City, California, USA
 *   - Source: official Greenhouse-hosted careers board (public Job
 *     Board API)
 *   - Live roles observed at probe time: 57
 *   - Read-only, unauthenticated ingestion normalized into the Ever
 *     Jobs schema
 *
 * Source profile (Spec 820):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/c3iot/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'C3 AI'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 57 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/c3iot/jobs';

@SourcePlugin({
  site: Site.C3_AI,
  name: 'C3 AI',
  category: 'company',
})
@Injectable()
export class C3AIService implements IScraper {
  private readonly logger = new Logger(C3AIService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`C3 AI: fetching ${url}`);

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
        const id = `c3iot-${jobId}`;

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
            site: Site.C3_AI,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'C3 AI',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/c3iot/jobs/${listing.id}`,
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

      this.logger.log(`C3 AI: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`C3 AI scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
