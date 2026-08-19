import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * tastytrade — tastytrade is a Chicago-based online brokerage offering commission-friendly options, futures, stock, and crypto trading on its own self-directed platforms..
 *
 * tastytrade, Inc. is a U.S. self-directed online brokerage
 * headquartered in Chicago's Fulton Market, specializing in options,
 * futures, equities, and cryptocurrency trading for active retail
 * traders. Founded in 2011 (originally as a financial-media company)
 * and formerly operating its brokerage under the name tastyworks
 * before rebranding to tastytrade in 2023, it is part of IG Group
 * following IG's roughly $1 billion acquisition in 2021. The company
 * builds its own trading platforms and produces daily
 * financial-education content under the affiliated tastylive brand. It
 * is a FINRA-registered broker-dealer.
 *
 * Sector: Fintech / Online Brokerage (Options & Futures Trading). HQ: Chicago, Illinois, USA.
 *
 * Highlights:
 *   - Headquartered in Chicago, Illinois (Fulton Market), matching the
 *     board's Chicago job locations
 *   - Specializes in options, futures, stock, and crypto trading for
 *     self-directed retail traders
 *   - Rebranded from tastyworks to tastytrade in 2023
 *   - Part of IG Group, which acquired tastytrade for roughly $1
 *     billion in 2021
 *   - FINRA-registered broker-dealer; affiliated with the tastylive
 *     financial-education brand
 *
 * Source profile (Spec 799):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/tastytrade/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'tastytrade'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 7 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/tastytrade/jobs';

@SourcePlugin({
  site: Site.TASTYTRADE,
  name: 'tastytrade',
  category: 'company',
})
@Injectable()
export class TastytradeService implements IScraper {
  private readonly logger = new Logger(TastytradeService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`tastytrade: fetching ${url}`);

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
        const id = `tastytrade-${jobId}`;

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
            site: Site.TASTYTRADE,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'tastytrade',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/tastytrade/jobs/${listing.id}`,
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

      this.logger.log(`tastytrade: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`tastytrade scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
