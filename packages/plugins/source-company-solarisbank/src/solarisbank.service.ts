import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Solaris — Solaris is a German Banking-as-a-Service provider that lets companies embed regulated financial products, such as accounts, cards, and lending, into their own offerings via APIs..
 *
 * Solaris SE (legally named Solarisbank AG until its November 2022
 * rebrand to Solaris SE) is a Berlin-headquartered technology company
 * holding a full German banking license, regulated by BaFin. It
 * operates a Banking-as-a-Service platform that exposes API-based
 * banking infrastructure so partner companies can offer their own
 * financial products, including current accounts, debit and credit
 * cards, deposit accounts, and consumer lending. The Greenhouse board
 * slug "solarisbank" reflects the company's original name, while the
 * board displays the current "Solaris" brand. The sampled roles
 * (Credit Risk Manager, Head of Process Architecture & Policy
 * Management, Junior Card Operations Analyst) and the Frankfurt/Berlin
 * locations are consistent with a German regulated bank and card
 * issuer.
 *
 * Sector: Fintech / Banking-as-a-Service (Embedded Finance). HQ: Berlin, Germany.
 *
 * Highlights:
 *   - Holds a full German banking license and is regulated by BaFin,
 *     operating as a credit institution across Europe
 *   - Founded in 2015 (launched 2016) out of the Finleap company
 *     builder in Berlin
 *   - Rebranded from Solarisbank AG to Solaris SE in November 2022
 *   - Provides embedded finance via APIs: accounts, debit/credit
 *     cards, deposit accounts, and consumer loans
 *   - Operates beyond Berlin with locations including Frankfurt and
 *     other European branches
 *
 * Source profile (Spec 797):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/solarisbank/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'Solaris'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 16 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/solarisbank/jobs';

@SourcePlugin({
  site: Site.SOLARIS,
  name: 'Solaris',
  category: 'company',
})
@Injectable()
export class SolarisService implements IScraper {
  private readonly logger = new Logger(SolarisService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Solaris: fetching ${url}`);

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
        const id = `solarisbank-${jobId}`;

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
            site: Site.SOLARIS,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'Solaris',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/solarisbank/jobs/${listing.id}`,
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

      this.logger.log(`Solaris: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Solaris scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
