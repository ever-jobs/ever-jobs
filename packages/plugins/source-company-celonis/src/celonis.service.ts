import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Celonis SE — operator of the **dominant Process Intelligence /
 * Process Mining cloud platform** (founded by Bastian Nominacher,
 * Alexander Rinke, and Martin Klenk in 2011 in Munich, Germany;
 * private since the 2022 Series D round at ~$13B valuation;
 * ships the Celonis Process Intelligence Platform with Process
 * Mining, Object-Centric Process Mining (OCPM), Process Sphere,
 * the Celonis Studio low-code action engine, and Celonis Apps
 * for ERP / SCM / O2C / P2P / RTR — alongside competitors
 * UiPath, Microsoft Power Automate Process Mining, Software AG
 * ARIS, QPR, Signavio (now SAP), and Apromore — with a hybrid
 * distributed workforce concentrated across Munich (HQ), New
 * York City (US HQ), Amsterdam, London, Madrid, Paris, Tokyo,
 * Singapore, and Remote across the Americas / EMEA / APAC) —
 * publishes its consolidated careers board through Greenhouse
 * at the bare slug `celonis` (case-symmetric with the wire
 * `company_name === 'Celonis'`; see Spec 140 § 4).
 *
 * **Zero structural deviations from the Doximity (Spec 127)
 * template** — making this the **thirty-sixth** Greenhouse-
 * only company-direct plugin in run-history to ship as a
 * clean re-spin. All five primary axes share with Doximity,
 * with a notable D-10 sub-axis observation:
 *
 *   - **D-04 — wire-shape variant 2 (canonical Greenhouse host).**
 *     `https://job-boards.greenhouse.io/celonis/jobs/<id>`.
 *     **Fifty-fourth** plugin in the cohort to use variant 2.
 *
 *   - **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     **Ninety-sixth** plugin to apply D-08.
 *
 *   - **D-09 — brand-name trim omitted (case-symmetric).** Wire
 *     `company_name === 'Celonis'` byte-for-byte (7 bytes —
 *     fully clean, case-symmetric with the lowercase 7-byte
 *     slug `celonis`). **Eighty-seventh cohort plugin to omit
 *     D-09**.
 *
 *   - **D-10 — wire-title `.trim()` applied (mixed leading-pad
 *     + trailing-pad form).** 26 of 188 wire titles in the
 *     run-350 probe carry padding (~13.8 % pad rate) — 23
 *     trailing-pad + 3 leading-pad in the same plugin.
 *     **Third cohort observation of leading-pad sub-axis**
 *     after Chainguard (Spec 122 — leading-only, first
 *     observation) and Oscar (Spec 133 — 1 leading + 1
 *     trailing at ~0.81 %). Celonis is the **first cohort
 *     plugin to observe leading-pad at meaningful volume**
 *     (3 leading samples). `.trim()` covers both directions
 *     transparently. **Fifty-ninth cohort plugin to apply
 *     D-10**.
 *
 *   - **D-11 — fully-clean department pass-through.** 0 of 188
 *     wire department names padded across 12 unique departments
 *     (`'Sales'`, `'Sales & Partner Mgmt'`, `'Value
 *     Engineering'`, `'Business Development'`, `'Services'`,
 *     `'Engineering'`, `'Corporate'`, `'IT & Systems'`,
 *     `'Product'`, `'Ecosystem'`, `'Product Business Apps'`,
 *     `'Legal'` — clean multi-token forms with internal
 *     whitespace and ampersands). Pass-through preserves
 *     byte-for-byte. **Seventy-seventh cohort plugin** with
 *     fully-clean department pass-through.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/celonis/jobs';

@SourcePlugin({
  site: Site.CELONIS,
  name: 'Celonis',
  category: 'company',
})
@Injectable()
export class CelonisService implements IScraper {
  private readonly logger = new Logger(CelonisService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Celonis: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10 applied (mixed leading + trailing pad form):
        // 26/188 wire titles padded (~13.8 %); 23 trailing-pad
        // + 3 leading-pad. `.trim()` covers both directions.
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
        const id = `celonis-${jobId}`;

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
            site: Site.CELONIS,
            title,
            // D-09 omitted: case-symmetric bare-brand wire.
            companyName: listing.company_name ?? 'Celonis',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/celonis/jobs/${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            // D-11 omitted: 0/188 wire departments padded.
            department: listing.departments?.[0]?.name ?? null,
          }),
        );
      }

      this.logger.log(`Celonis: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Celonis scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
