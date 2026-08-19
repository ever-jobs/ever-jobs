import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Nauto — AI-powered driver and fleet safety platform that uses in-vehicle cameras and computer vision to prevent collisions.
 *
 * Nauto is a technology company that builds an AI-powered driver and
 * fleet safety platform. Its system combines in-vehicle cameras with
 * computer vision and machine learning to analyze driver behavior,
 * detect distraction and risk in real time, and deliver alerts and
 * coaching insights aimed at preventing collisions. The platform helps
 * commercial fleets reduce accidents, improve driver performance, and
 * lower operational risk.
 *
 * Sector: Automotive / Fleet Safety AI. HQ: Palo Alto, California, USA.
 *
 * Highlights:
 *   - AI and computer vision platform for fleet and driver safety
 *   - In-vehicle device with real-time distraction and risk detection
 *   - Collision prevention and driver coaching for commercial fleets
 *   - Headquartered in Palo Alto, California (Stanford Research Park)
 *   - Serves enterprise and commercial fleet operators
 *
 * Source profile (Spec 749):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/nauto/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'Nauto'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 4 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/nauto/jobs';

@SourcePlugin({
  site: Site.NAUTO,
  name: 'Nauto',
  category: 'company',
})
@Injectable()
export class NautoService implements IScraper {
  private readonly logger = new Logger(NautoService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Nauto: fetching ${url}`);

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
        const id = `nauto-${jobId}`;

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
            site: Site.NAUTO,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'Nauto',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/nauto/jobs/${listing.id}`,
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

      this.logger.log(`Nauto: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Nauto scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
