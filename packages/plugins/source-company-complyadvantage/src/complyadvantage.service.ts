import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * ComplyAdvantage Ltd. — operator of the **dominant AI-driven
 * financial-crime risk intelligence and AML/CFT compliance
 * platform** (founded by Charles Delingpole in 2014 in London,
 * UK; private since the 2022 Series D round at ~$3B valuation;
 * ships ComplyAdvantage Customer Screening, Transaction
 * Monitoring, Adverse Media Screening, and Mesh AI agentic
 * workflow automation across the financial-crime-prevention /
 * AML-compliance / fintech-regtech vertical — alongside
 * competitors Refinitiv World-Check (LSEG), Dow Jones Risk &
 * Compliance, NameScan, Sanction Scanner, and ComplyCube — with
 * a hybrid distributed workforce concentrated across London
 * (HQ), New York City (US HQ), Singapore, Bucharest, and Remote
 * across the United Kingdom, the United States, EMEA, and APAC)
 * — publishes its consolidated careers board through Greenhouse
 * at the bare slug `complyadvantage` (case-asymmetric vs the
 * wire `company_name === 'ComplyAdvantage'` — TWO-cap PascalCase
 * form with caps at byte indices 0 and 6; see Spec 141 § 4).
 *
 * **One structural deviation from the Epic Games (Spec 069)
 * template** — D-09 sub-axis (Epic Games multi-token bare-
 * brand `'Epic Games'` with internal whitespace → ComplyAdvantage
 * TWO-cap PascalCase concatenated `'ComplyAdvantage'`).
 *
 *   - **D-04 — wire-shape variant 13 (bare brand-domain dual-
 *     id form).** ComplyAdvantage publishes `absolute_url` on
 *     `https://complyadvantage.com/careers/jobs/<id>?gh_jid=<id>`
 *     — bare brand-domain `complyadvantage.com` (no `www.`
 *     prefix) + `/careers/jobs/<id>` path + dual-id form
 *     (id-in-path + `gh_jid` query). **Sixth** plugin in the
 *     cohort to use **wire-shape variant 13** after Epic Games
 *     (Spec 069 — first observation), and the lineage of
 *     Bitwarden / Fivetran / Lattice / Stitch Fix sister forms.
 *     The plugin emits `listing.absolute_url` byte-for-byte;
 *     the **fallback** `jobUrl` constructor defaults to the
 *     canonical Greenhouse variant-2 form
 *     `https://job-boards.greenhouse.io/complyadvantage/jobs/<id>`
 *     rather than reconstructing the vanity-domain shape (same
 *     defence-in-depth strategy as Epic Games, Bitwarden, Stitch
 *     Fix).
 *
 *   - **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     **Ninety-seventh** plugin to apply D-08.
 *
 *   - **D-09 — brand-name trim omitted (TWO-cap PascalCase case-
 *     asymmetric wire form).** Wire `company_name === 'ComplyAdvantage'`
 *     byte-for-byte (15 bytes; case-asymmetric vs the lowercase
 *     15-byte slug `complyadvantage` at TWO byte indices: 0
 *     (`C` vs `c`) and 6 (`A` vs `a`) — caps form embedded
 *     `Advantage` word boundary). **Sixth cohort observation
 *     of TWO-cap PascalCase D-09 sub-axis** after SoFi (caps
 *     0/2), StockX (caps 0/5), xAI (caps 0/2 with lowercase
 *     first letter), LaunchDarkly (caps 0/6), and PagerDuty
 *     (caps 0/5). **Caps-at-0/6 matches LaunchDarkly exactly**
 *     — second cohort plugin with this caps-position sub-
 *     pattern. **Eighty-eighth cohort plugin to omit D-09**.
 *
 *   - **D-10 — wire-title `.trim()` applied (trailing-pad form).**
 *     8 of 33 wire titles in the run-351 probe carry trailing
 *     padding (~24.2 % pad rate, all trailing-only).
 *     **Sixtieth cohort plugin to apply D-10**.
 *
 *   - **D-11 — fully-clean department pass-through.** 0 of 33
 *     wire department names padded across 5 unique departments
 *     (`'Commercial'`, `'Technology'`, `'Finance'`, `'Marketing'`,
 *     `'Product'` — clean single-token forms). Pass-through
 *     preserves byte-for-byte. **Seventy-eighth cohort plugin**
 *     with fully-clean department pass-through.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/complyadvantage/jobs';

@SourcePlugin({
  site: Site.COMPLYADVANTAGE,
  name: 'ComplyAdvantage',
  category: 'company',
})
@Injectable()
export class ComplyAdvantageService implements IScraper {
  private readonly logger = new Logger(ComplyAdvantageService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`ComplyAdvantage: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10 applied (trailing-pad form): 8/33 wire titles
        // padded (~24.2 %), all trailing-only.
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
        const id = `complyadvantage-${jobId}`;

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
            site: Site.COMPLYADVANTAGE,
            title,
            // D-09 omitted: TWO-cap PascalCase case-asymmetric
            // wire form 'ComplyAdvantage' (caps 0/6).
            companyName: listing.company_name ?? 'ComplyAdvantage',
            // D-04: wire `absolute_url` flows through (variant 13
            // — bare brand-domain dual-id form). Fallback uses
            // canonical Greenhouse variant-2 form rather than
            // reconstructing the vanity-domain shape.
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/complyadvantage/jobs/${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            // D-11 omitted: 0/33 wire departments padded.
            department: listing.departments?.[0]?.name ?? null,
          }),
        );
      }

      this.logger.log(`ComplyAdvantage: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`ComplyAdvantage scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
