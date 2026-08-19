import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * BVNK — BVNK is a stablecoin-focused payments infrastructure company that helps businesses send, receive, and settle payments across fiat and digital currencies..
 *
 * BVNK provides payments infrastructure that bridges traditional fiat
 * currencies and stablecoins, enabling businesses to move money
 * globally with embedded wallets, settlement, and conversion. The
 * company operates as a regulated financial services provider with a
 * strong emphasis on compliance and financial crime controls. It runs
 * distributed teams across the UK, Europe, and South Africa.
 *
 * Sector: Payments infrastructure (stablecoins/fintech). HQ: London, United Kingdom.
 *
 * Highlights:
 *   - Hiring across product, design, engineering/QA, and financial
 *     crime and compliance functions (~19 open roles)
 *   - Operates internationally with roles spanning the UK, Poland,
 *     Spain, Malta, Bulgaria, and South Africa
 *   - Focus on regulated stablecoin and fiat payments with dedicated
 *     compliance and financial crime product work
 *
 * Source profile (Spec 684):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/bvnk/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'BVNK'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 19 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/bvnk/jobs';

@SourcePlugin({
  site: Site.BVNK,
  name: 'BVNK',
  category: 'company',
})
@Injectable()
export class BVNKService implements IScraper {
  private readonly logger = new Logger(BVNKService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`BVNK: fetching ${url}`);

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
        const id = `bvnk-${jobId}`;

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
            site: Site.BVNK,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'BVNK',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/bvnk/jobs/${listing.id}`,
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

      this.logger.log(`BVNK: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`BVNK scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
