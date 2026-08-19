import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Akoya — API-based open finance network for consumer-permissioned financial data sharing..
 *
 * Akoya operates an API-based open finance data access network that
 * connects financial institutions with fintechs and data aggregators
 * to share consumer-permissioned financial data. The network uses
 * tokenized, OAuth-based access aligned with Financial Data Exchange
 * (FDX) standards, avoiding screen scraping and credential sharing.
 * Akoya was spun off from Fidelity Investments in 2020 and is owned by
 * a group of major U.S. banks and financial firms.
 *
 * Sector: Financial technology (open finance / data access). HQ: Boston, USA.
 *
 * Highlights:
 *   - API-based data access network connecting financial institutions,
 *     fintechs, and data aggregators
 *   - Consumer-permissioned, tokenized data sharing built on OAuth and
 *     FDX standards (no screen scraping)
 *   - Spun off from Fidelity Investments in 2020; owned by a
 *     consortium of major U.S. banks
 *   - Hiring across Product Engineering, Marketing, Risk, and G&A in
 *     Boston, NYC, and Raleigh (plus remote)
 *
 * Source profile (Spec 223):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/akoya/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'Akoya'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 4 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/akoya/jobs';

@SourcePlugin({
  site: Site.AKOYA,
  name: 'Akoya',
  category: 'company',
})
@Injectable()
export class AkoyaService implements IScraper {
  private readonly logger = new Logger(AkoyaService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Akoya: fetching ${url}`);

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
        const id = `akoya-${jobId}`;

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
            site: Site.AKOYA,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'Akoya',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/akoya/jobs/${listing.id}`,
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

      this.logger.log(`Akoya: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Akoya scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
