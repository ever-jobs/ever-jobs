import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Ezra — B2B digital lending and credit-scoring platform for emerging markets.
 *
 * Ezra is a financial-technology company that provides B2B digital
 * lending solutions for emerging markets, partnering with mobile
 * network operators, digital wallet providers, banks and other
 * financial institutions to deliver embedded credit products. Its
 * flagship offerings include Airtime Credit Services (ACS), Nano
 * micro-cash advances and Buy Now, Pay Later (BNPL), powered by
 * proprietary credit-scoring algorithms, alternative data and
 * machine-learning models. The company supports operations across
 * Africa, the Middle East and Asia, with key offices in Nairobi, Kenya
 * and Dubai, UAE.
 *
 * Sector: Fintech. HQ: Nairobi, Kenya.
 *
 * Highlights:
 *   - Supports 24 operations across 23 countries in Africa, the Middle
 *     East and Asia
 *   - Flagship products include Airtime Credit Services, Nano cash
 *     advances and BNPL
 *   - Processes roughly 21 million loan requests and 1.4 TB of data
 *     daily
 *
 * Source profile (Spec 639):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/ezra/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'Ezra'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 12 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/ezra/jobs';

@SourcePlugin({
  site: Site.EZRA,
  name: 'Ezra',
  category: 'company',
})
@Injectable()
export class EzraService implements IScraper {
  private readonly logger = new Logger(EzraService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Ezra: fetching ${url}`);

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
        const id = `ezra-${jobId}`;

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
            site: Site.EZRA,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'Ezra',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/ezra/jobs/${listing.id}`,
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

      this.logger.log(`Ezra: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Ezra scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
