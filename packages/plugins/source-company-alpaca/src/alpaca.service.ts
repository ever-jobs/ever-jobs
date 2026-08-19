import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Alpaca  — Developer-first brokerage infrastructure and trading APIs for embedded investing..
 *
 * Alpaca is a developer-focused financial services company that
 * provides brokerage infrastructure and APIs, enabling other
 * businesses to embed stock, ETF, and crypto trading into their own
 * products. Its hiring spans brokerage operations, compliance, legal,
 * engineering, and customer success across a globally distributed
 * remote workforce covering the Americas, EMEA, the UK, and APAC.
 * Roles such as Chief Anti-Money Laundering Officer, Appointed
 * Representatives compliance, and regional brokerage operations
 * indicate a regulated, multi-jurisdiction operating model.
 *
 * Sector: Fintech / Brokerage Infrastructure. HQ: San Mateo, California, United States.
 *
 * Highlights:
 *   - Provides API-driven brokerage infrastructure for stocks, ETFs,
 *     and crypto
 *   - Operates across multiple regulated jurisdictions (Americas,
 *     UK/EMEA, Canada, Saudi Arabia, APAC)
 *   - Globally distributed remote-first workforce
 *   - Strong compliance and AML focus, including a CAMLO role and
 *     Appointed Representatives program
 *   - Hiring across brokerage, compliance, legal, engineering, and
 *     customer success
 *
 * Source profile (Spec 239):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/alpaca/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'Alpaca '`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 56 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/alpaca/jobs';

@SourcePlugin({
  site: Site.ALPACA,
  name: 'Alpaca ',
  category: 'company',
})
@Injectable()
export class AlpacaService implements IScraper {
  private readonly logger = new Logger(AlpacaService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Alpaca : fetching ${url}`);

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
        const id = `alpaca-${jobId}`;

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
            site: Site.ALPACA,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'Alpaca ',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/alpaca/jobs/${listing.id}`,
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

      this.logger.log(`Alpaca : scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Alpaca  scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
