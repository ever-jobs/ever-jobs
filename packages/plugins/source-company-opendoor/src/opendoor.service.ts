import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Opendoor Technologies, Inc. — operator of the **dominant
 * US-residential iBuyer + cash-offer-on-your-home platform
 * pioneered around the algorithmic-property-valuation-as-a-
 * service data model** (founded by Eric Wu, Keith Rabois, Ian
 * Wong, and JD Ross in 2014 in San Francisco; public on the
 * NASDAQ since December 2020 SPAC merger with Social Capital
 * Hedosophia II at $4.8B initial valuation under ticker
 * `OPEN`; ships Opendoor Cash Offer (instant-buy iBuying),
 * Opendoor List With Us (agent-assisted listing), Opendoor
 * Backed Offers, Opendoor Marketplace (B2B partnership with
 * Zillow), and Opendoor Home Improvements across the iBuyer
 * / instant-residential-real-estate / proptech segment —
 * alongside competitors Offerpad, Knock, Zillow Offers
 * (defunct 2021), Redfin Now (defunct 2022), and Bungalo —
 * with a hybrid distributed workforce concentrated across
 * San Francisco (HQ), Phoenix, Atlanta, Dallas, and Remote
 * across the United States) — publishes its consolidated
 * careers board through Greenhouse at the bare slug
 * `opendoor` (case-symmetric with the wire `company_name ===
 * 'Opendoor'`; see Spec 132 § 10 D-05).
 *
 * **One structural deviation from the Dremio (Spec 128)
 * template** — D-04 wire-shape variant 34 (first cohort
 * plugin to use variant 34; **first cohort observation of
 * HTTPS-scheme `www.`-prefixed brand-domain `/careers/open-
 * positions` query-only-id**). Variant 34 is sister to
 * Dremio's variant 33 (HTTPS + www + query-only-id, different
 * leaf path: `/careers/open-positions` no-trailing-slash vs
 * `/careers/job-postings/` with-trailing-slash).
 *
 *   1. **D-04 — wire-shape variant 34 (HTTPS-scheme `www.`-
 *      prefixed brand-domain `/careers/open-positions` query-
 *      only-id — first cohort observation).** Opendoor
 *      publishes its `absolute_url` on a **previously-
 *      unobserved** shape
 *      `https://www.opendoor.com/careers/open-positions?gh_jid=<id>`.
 *      **First** plugin in the cohort to use **wire-shape
 *      variant 34** — the **thirty-seventh distinct wire-
 *      shape variant** in the company-direct cohort.
 *
 *      The plugin emits `listing.absolute_url` byte-for-byte;
 *      the **fallback** `jobUrl` constructor defaults to the
 *      canonical Greenhouse **variant-2** form
 *      `https://job-boards.greenhouse.io/opendoor/jobs/<id>`.
 *
 * Shared with Dremio:
 *
 *   - **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     **Eighty-eighth** plugin to apply D-08.
 *
 *   - **D-09 — brand-name trim omitted (case-symmetric).** Wire
 *     `company_name === 'Opendoor'` byte-for-byte (8 bytes —
 *     fully clean, case-symmetric with the lowercase 8-byte
 *     slug `opendoor`). **Seventy-ninth cohort plugin to omit
 *     D-09**.
 *
 *   - **D-10 — wire-title `.trim()` applied with FIRST-COHORT
 *     internal-double-whitespace observation.** 4 of 66 wire
 *     titles in the run-342 probe carry trailing ASCII-space
 *     padding (~6.1 % pad rate) — but **one carries internal
 *     double-whitespace** (`'Customer Experience  Specialist '`
 *     — two consecutive spaces between `Experience` and
 *     `Specialist`, plus trailing pad). **First cohort
 *     observation of internal-double-whitespace title
 *     anomaly** in 51 prior D-10-applying plugins. The
 *     plugin's `.trim()` operation strips trailing pad
 *     transparently; **internal anomaly preserved byte-for-
 *     byte** as part of the title. **Fifty-second cohort
 *     plugin to apply D-10**.
 *
 *   - **D-11 — fully-clean department pass-through.** 0 of 66
 *     wire department names padded across 11 unique departments
 *     (`'Engineering'`, `'Evergreen'`, `'Executive Support'`,
 *     `'Finance & Accounting'`, `'Home Operations'`,
 *     `'Information Technology & Security'`, `'Legal'`,
 *     `'Marketing'`, `'Research & Data Science'`, `'Sales &
 *     Support'`, `'Valuations'` — clean multi-token forms with
 *     internal whitespace and ampersands). **Seventieth cohort
 *     plugin** with fully-clean department pass-through —
 *     **the cohort crosses the 70-plugin D-11-omission
 *     threshold at this run**.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/opendoor/jobs';

@SourcePlugin({
  site: Site.OPENDOOR,
  name: 'Opendoor',
  category: 'company',
})
@Injectable()
export class OpendoorService implements IScraper {
  private readonly logger = new Logger(OpendoorService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Opendoor: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10 applied with first-cohort internal-double-
        // whitespace observation: 4/66 wire titles padded
        // (~6.1 %); one carries internal double-space
        // anomaly. `.trim()` strips trailing only; internal
        // preserved byte-for-byte.
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
        const id = `opendoor-${jobId}`;

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
            site: Site.OPENDOOR,
            title,
            // D-09 omitted: case-symmetric bare-brand wire.
            companyName: listing.company_name ?? 'Opendoor',
            // D-04: wire `absolute_url` flows through (variant
            // 34 — HTTPS `www.opendoor.com/careers/open-
            // positions?gh_jid=<id>`). Fallback uses canonical
            // Greenhouse variant-2.
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/opendoor/jobs/${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            // D-11 omitted: 0/66 wire departments padded.
            department: listing.departments?.[0]?.name ?? null,
          }),
        );
      }

      this.logger.log(`Opendoor: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Opendoor scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
