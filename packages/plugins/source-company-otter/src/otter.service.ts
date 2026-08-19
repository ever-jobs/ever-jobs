import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Otter, Inc. — operator of the **dominant food-delivery
 * infrastructure platform pioneered around the multi-tenant
 * virtual-restaurant / cloud-kitchen / unified-POS data model**
 * (founded by Alex Canter in 2017 in Los Angeles as Ordermark;
 * rebranded to Otter in 2021; raised ~$63M across rounds at
 * peak ~$300M valuation in 2020 led by NTT DOCOMO Ventures and
 * Tiger Global Management; ships Otter Brick-and-Mortar
 * (in-store POS), Otter Central Ops (multi-location ops
 * orchestration), and Otter for Enterprise / SMB across the
 * food-delivery infrastructure / cloud-kitchen / virtual-
 * restaurant segment — alongside competitors Toast,
 * DeliveryHero, ChowNow, and Square for Restaurants — with a
 * hybrid distributed workforce concentrated across Mountain
 * View, Los Angeles, and Remote across the United States) —
 * publishes its consolidated careers board through Greenhouse
 * at the bare slug `otter` (the lowercase 5-byte slug; case-
 * symmetric with the wire `company_name === 'Otter'`; see
 * Spec 116 § 10 D-05).
 *
 * **Zero structural deviations from the Airtable (Spec 106)
 * template** — making this the **twentieth** Greenhouse-only
 * company-direct plugin in run-history to ship as a clean re-
 * spin. All five primary axes share with Airtable:
 *
 *   - **D-04 — wire-shape variant 2 (canonical Greenhouse host).**
 *     `https://job-boards.greenhouse.io/otter/jobs/<id>`.
 *     **Thirty-sixth** plugin in the cohort to use variant 2.
 *
 *   - **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     **Seventy-second** plugin to apply D-08.
 *
 *   - **D-09 — brand-name trim omitted (case-symmetric).** Wire
 *     `company_name === 'Otter'` byte-for-byte (5 bytes —
 *     fully clean, case-symmetric with the lowercase 5-byte
 *     slug `otter`). **Sixty-third cohort plugin to omit D-09**.
 *
 *   - **D-10 — wire-title `.trim()` applied (trailing-pad form).**
 *     5 of 39 wire titles in the run-326 probe carry trailing
 *     ASCII-space padding (~12.8 % pad rate; e.g. `'Backend
 *     Software Engineer, Otter - Los Angeles '`). All trailing-
 *     only. **Fortieth cohort plugin to apply D-10 — the
 *     cohort crosses the 40-plugin D-10-application threshold
 *     at this run**.
 *
 *   - **D-11 — fully-clean department pass-through.** 0 of 39
 *     wire department names padded across 16 unique departments
 *     (`'ENG Beam'`, `'ENG Brick & Mortar'`, `'ENG Facility'`,
 *     `'ENG System of Record'`, `'Engineering Talent Network'`,
 *     `'Finance'`, `'Hardware Engineering'`, `'Otter - ENT'`,
 *     `'Otter - SMB'`, `'Otter Central Ops'`, `'PD Brick &
 *     Mortar'`, `'PM Brick & Mortar'`, plus 4 others — clean
 *     multi-token forms with internal whitespace, ampersands,
 *     and acronym prefixes). **Fifty-seventh cohort plugin**
 *     with fully-clean department pass-through.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/otter/jobs';

@SourcePlugin({
  site: Site.OTTER,
  name: 'Otter',
  category: 'company',
})
@Injectable()
export class OtterService implements IScraper {
  private readonly logger = new Logger(OtterService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Otter: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10 applied (trailing-pad form): 5/39 wire titles
        // padded (~12.8 %).
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
        const id = `otter-${jobId}`;

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
            site: Site.OTTER,
            title,
            // D-09 omitted: case-symmetric bare-brand wire.
            companyName: listing.company_name ?? 'Otter',
            // D-04: wire `absolute_url` flows through (variant 2
            // — canonical Greenhouse host).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/otter/jobs/${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            // D-11 omitted: 0/39 wire departments padded.
            department: listing.departments?.[0]?.name ?? null,
          }),
        );
      }

      this.logger.log(`Otter: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Otter scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
