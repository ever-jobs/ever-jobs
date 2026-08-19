import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Axon Enterprise, Inc. — operator of the **dominant US-
 * public-safety + connected-policing platform pioneered
 * around the TASER-conducted-energy-weapon-as-platform /
 * body-worn-camera-as-cloud-service / Evidence-com-as-DEMS
 * data model** (founded by Rick Smith and Tom Smith in 1993
 * as TASER International in Scottsdale; rebranded to Axon
 * in April 2017; public on the NASDAQ since May 2001 IPO
 * under ticker `TASR`, renamed to `AXON` in April 2017;
 * ships TASER 7 / TASER 10 (CEW conducted energy weapons),
 * Axon Body 4 (body-worn cameras), Axon Fleet 3 (in-car
 * video), Axon Records, Axon Evidence (Evidence.com DEMS),
 * Axon Justice (prosecution case-management), Axon Air
 * (drone), and Axon Skybridge (cloud-based command center)
 * — alongside competitors WatchGuard (now Motorola), Digital
 * Ally, Reveal Media, and Verint — with a hybrid distributed
 * workforce concentrated across Scottsdale (HQ), Seattle,
 * San Francisco, Boston, London, Sydney, and Remote across
 * the United States, the United Kingdom, the European Union,
 * Canada, Australia, and the Asia-Pacific region) — publishes
 * its consolidated careers board through Greenhouse at the
 * bare slug `axon` (case-symmetric with the wire `company_name
 * === 'Axon'`; see Spec 135 § 10 D-05).
 *
 * **Zero structural deviations from the Doximity (Spec 127)
 * template** — making this the **thirty-third** Greenhouse-
 * only company-direct plugin in run-history to ship as a
 * clean re-spin. **Run #345 launches the ninth fresh probe
 * sweep**. All five primary axes share with Doximity, with
 * notable D-11 sub-axis observations:
 *
 *   - **D-04 — wire-shape variant 2 (canonical Greenhouse host).**
 *     `https://job-boards.greenhouse.io/axon/jobs/<id>`.
 *     **Fiftieth** plugin in the cohort to use variant 2 —
 *     **the cohort crosses the 50-plugin variant-2 threshold
 *     at this run**.
 *
 *   - **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     **Ninety-first** plugin to apply D-08.
 *
 *   - **D-09 — brand-name trim omitted (case-symmetric).** Wire
 *     `company_name === 'Axon'` byte-for-byte (4 bytes —
 *     fully clean, case-symmetric with the lowercase 4-byte
 *     slug `axon`). **Eighty-second cohort plugin to omit
 *     D-09**.
 *
 *   - **D-10 — wire-title `.trim()` applied (trailing-pad form).**
 *     90 of 539 wire titles in the run-345 probe carry
 *     trailing ASCII-space padding (~16.7 % pad rate, all
 *     trailing-only). **Fifty-fifth cohort plugin to apply
 *     D-10**.
 *
 *   - **D-11 — fully-clean department pass-through with two
 *     sub-axis observations.** 0 of 539 wire department names
 *     padded across 85 unique departments — but with two
 *     observability notes:
 *     a) **Second-cohort numeric-prefix-with-space dept
 *        naming convention** — all 85 follow `<numeric_code>
 *        <name>` (e.g. `'1001 Manufacturing Engineering'`).
 *        Same convention as Constant Contact (Spec 111).
 *        Distinct from Dialpad's numeric-prefix-with-hyphen
 *        (Spec 126).
 *     b) **First-cohort observation of internal-double-
 *        whitespace anomaly in dept-name field** —
 *        `'1105 SCM - Distribution &  Warehousing -
 *        Skybridge'` (2 consecutive spaces between `&` and
 *        `Warehousing`). Pass-through preserves byte-for-
 *        byte.
 *     **Seventy-third cohort plugin** with fully-clean
 *     department pass-through.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/axon/jobs';

@SourcePlugin({
  site: Site.AXON,
  name: 'Axon',
  category: 'company',
})
@Injectable()
export class AxonService implements IScraper {
  private readonly logger = new Logger(AxonService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Axon: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10 applied (trailing-pad form): 90/539 wire titles
        // padded (~16.7 %).
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
        const id = `axon-${jobId}`;

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
            site: Site.AXON,
            title,
            // D-09 omitted: case-symmetric bare-brand wire.
            companyName: listing.company_name ?? 'Axon',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/axon/jobs/${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            // D-11 omitted: 0/539 wire departments padded
            // (numeric-prefix-with-space + internal-double-
            // whitespace observability preserved byte-for-
            // byte).
            department: listing.departments?.[0]?.name ?? null,
          }),
        );
      }

      this.logger.log(`Axon: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Axon scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
