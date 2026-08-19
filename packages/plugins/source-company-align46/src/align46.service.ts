import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Align Communications — Technology infrastructure firm offering data center design-build, migration, and managed IT services..
 *
 * Align (Align Communications, Inc.) is a technology infrastructure
 * and professional services firm founded in 1986 and headquartered in
 * New York City. It provides data center design, build, consolidation,
 * and migration services along with managed IT and cybersecurity
 * offerings for enterprise clients. Hiring signals show BIM/Revit
 * design roles within its Data Center Solutions practice and
 * business-systems and managed-services positions across multiple U.S.
 * offices.
 *
 * Sector: IT Services / Data Center Infrastructure. HQ: New York City, New York, United States.
 *
 * Highlights:
 *   - Data Center Solutions practice spanning design, procure & build
 *     and assess & modernize
 *   - BIM/Revit design specialist roles supporting data center
 *     construction documentation
 *   - Managed Services and managed IT services lines of business
 *   - Multi-state U.S. presence including Virginia, Texas, New Jersey,
 *     Ohio, Michigan, and Georgia
 *   - Business systems and operations roles indicating internal
 *     enterprise tooling needs
 *
 * Source profile (Spec 231):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/align46/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'Align Communications'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 20 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/align46/jobs';

@SourcePlugin({
  site: Site.ALIGN46,
  name: 'Align Communications',
  category: 'company',
})
@Injectable()
export class Align46Service implements IScraper {
  private readonly logger = new Logger(Align46Service.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Align Communications: fetching ${url}`);

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
        const id = `align46-${jobId}`;

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
            site: Site.ALIGN46,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'Align Communications',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/align46/jobs/${listing.id}`,
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

      this.logger.log(`Align Communications: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Align Communications scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
