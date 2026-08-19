import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Blend Labs, Inc. — operator of the **dominant US-mortgage-
 * origination + consumer-banking digital-platform pioneered
 * around the cloud-native-loan-origination data model**
 * (founded by Nima Ghamsari, Erin Collard, and Eugene
 * Marinelli in 2012 in San Francisco; public on the NYSE
 * since July 2021 IPO under ticker `BLND` at ~$3.6B initial
 * valuation; ships Blend Mortgage (loan origination for
 * ~285+ banks/credit unions including Wells Fargo and US
 * Bank), Blend Consumer Banking, Blend Title 365, and Blend
 * Builder (no-code workflow builder) across the mortgage-
 * tech / consumer-banking-software / digital-lending segment
 * — alongside competitors ICE Mortgage Technology (Encompass),
 * Rocket Pro, MeridianLink, Black Knight, Roostify, and Built
 * — with a hybrid distributed workforce concentrated across
 * San Francisco (HQ), Austin, and Remote across the United
 * States) — publishes its consolidated careers board through
 * Greenhouse at the bare slug `blend` (case-symmetric with
 * the wire `company_name === 'Blend'`; see Spec 138 § 10
 * D-05).
 *
 * **Zero structural deviations from the Doximity (Spec 127)
 * template** — making this the **thirty-fourth** Greenhouse-
 * only company-direct plugin in run-history to ship as a
 * clean re-spin. All five primary axes share with Doximity,
 * with a notable D-11 sub-axis observation:
 *
 *   - **D-04 — wire-shape variant 2 (canonical Greenhouse host).**
 *     `https://job-boards.greenhouse.io/blend/jobs/<id>`.
 *     **Fifty-second** plugin in the cohort to use variant 2.
 *
 *   - **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     **Ninety-fourth** plugin to apply D-08.
 *
 *   - **D-09 — brand-name trim omitted (case-symmetric).** Wire
 *     `company_name === 'Blend'` byte-for-byte (5 bytes —
 *     fully clean, case-symmetric with the lowercase 5-byte
 *     slug `blend`). **Eighty-fifth cohort plugin to omit
 *     D-09**.
 *
 *   - **D-10 — wire-title `.trim()` applied (trailing-pad form).**
 *     1 of 7 wire titles in the run-348 probe carries
 *     trailing ASCII-space padding (~14.3 % pad rate;
 *     `'Customer Success Manager '`). **Fifty-seventh cohort
 *     plugin to apply D-10**.
 *
 *   - **D-11 — fully-clean department pass-through with
 *     FIRST-COHORT company-suffix dept naming sub-axis.** 0
 *     of 7 wire department names padded across 4 unique
 *     departments — but **all 4 follow a `<dept-name>- Blend
 *     Labs` company-suffix convention** (`'Customer Success-
 *     Blend Labs'`, `'Growth Team- Blend Labs'`,
 *     `'Relationship Management - Blend Labs'`, `'Sales
 *     Engineering- Blend Labs'`). **First cohort observation
 *     of company-suffix dept naming convention** — every dept
 *     name carries the trailing `- Blend Labs` legal-entity
 *     suffix. Pass-through preserves byte-for-byte. **Seventy-
 *     fifth cohort plugin** with fully-clean department pass-
 *     through.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/blend/jobs';

@SourcePlugin({
  site: Site.BLEND,
  name: 'Blend',
  category: 'company',
})
@Injectable()
export class BlendService implements IScraper {
  private readonly logger = new Logger(BlendService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Blend: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10 applied (trailing-pad form): 1/7 wire titles
        // padded (~14.3 %).
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
        const id = `blend-${jobId}`;

        const locationStr = listing.location?.name ?? null;
        const location = locationStr
          ? new LocationDto({ city: locationStr })
          : null;

        if (input.location && locationStr) {
          if (!locationStr.toLowerCase().includes(input.location.toLowerCase())) continue;
        }

        jobs.push(
          new JobPostDto({
            id,
            site: Site.BLEND,
            title,
            // D-09 omitted: case-symmetric bare-brand wire.
            companyName: listing.company_name ?? 'Blend',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/blend/jobs/${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            // D-11 omitted: 0/7 wire departments padded
            // (company-suffix `'- Blend Labs'` convention
            // preserved byte-for-byte).
            department: listing.departments?.[0]?.name ?? null,
          }),
        );
      }

      this.logger.log(`Blend: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Blend scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
