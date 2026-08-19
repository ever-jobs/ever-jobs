import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Constant Contact, Inc. — operator of the **dominant SMB
 * email-marketing + automation platform pioneered around the
 * subscription-based small-business contact-and-list-management
 * data model** (founded by Randy Parker as Roving Software in
 * 1995; rebranded to Constant Contact in 2004; IPO'd on NASDAQ
 * in October 2007 at $108M; acquired by Endurance International
 * Group in 2016 for $1.1B; spun out as a private company under
 * Clearlake Capital + Siris Capital in February 2021 at a
 * ~$1B valuation; ships Constant Contact, Constant Contact AI
 * Content Generator, SharpSpring Marketing Automation (acquired
 * 2021), Vision6 (Australia, acquired 2022), and the Beewo
 * email-API platform across the SMB email-marketing /
 * marketing-automation segment — alongside competitors
 * Mailchimp, Klaviyo, ActiveCampaign, HubSpot Marketing,
 * Brevo (Sendinblue), and Drip — with a hybrid distributed
 * workforce concentrated across Waltham MA (HQ), Loveland CO,
 * Waterloo Ontario, and Remote across the United States and
 * Canada) — publishes its consolidated careers board through
 * Greenhouse at the bare slug `constantcontact` (the lowercase
 * concatenated brand-name; case-AND length-asymmetric with the
 * wire `company_name === 'Constant Contact'` two-word brand
 * with internal ASCII space — see Spec 111 § 10 D-05).
 *
 * **Zero structural deviations from the Misfits Market
 * (Spec 098) template** — making this the **eighteenth**
 * Greenhouse-only company-direct plugin in run-history to ship
 * as a clean re-spin (after Coursera, Flexport, Glossier,
 * Marqeta, New Relic, Scopely, Adyen, Bobbie, Cerebral, Misfits
 * Market, Monzo, PlanetScale, Airtable, Bandwidth, Braze, plus
 * corrected counts). All five primary axes share with Misfits
 * Market:
 *
 *   - **D-04 — wire-shape variant 2 (canonical Greenhouse
 *     host).** `https://job-boards.greenhouse.io/constantcontact/jobs/<id>`.
 *     **Thirty-fifth** plugin in the cohort to use variant 2.
 *
 *   - **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     **Sixty-seventh** plugin to apply D-08.
 *
 *   - **D-09 — brand-name trim omitted with INTERNAL-WHITESPACE
 *     wire asymmetry.** Wire `company_name === 'Constant Contact'`
 *     byte-for-byte (16 bytes — two-word brand with internal
 *     ASCII space at index 8; case-AND length-asymmetric vs the
 *     lowercase 15-byte concatenated slug `constantcontact`).
 *     **Seventh** internal-whitespace asymmetry case in the
 *     cohort (after Scale AI / Maven Clinic / Stitch Fix / New
 *     Relic / Dollar Shave Club / Misfits Market). 0 of 28
 *     padded. **Fifty-eighth cohort plugin to omit D-09**.
 *
 *   - **D-10 — wire-title `.trim()` applied (trailing-pad form).**
 *     1 of 28 wire titles in the run-321 probe carries trailing
 *     ASCII-space padding (~3.6 % pad rate). **Thirty-fifth
 *     cohort plugin to apply D-10**.
 *
 *   - **D-11 — fully-clean department pass-through with FIRST-
 *     COHORT numeric-prefix department naming convention.** 0 of
 *     28 wire department names padded across 9 unique departments
 *     — **all carry a numeric organizational-ID prefix** (`'100
 *     Engineering'`, `'126 Design'`, `'135 Product'`, `'142 High
 *     Volume Product'`, `'221 Marketing Acquisition'`, `'227
 *     Customer and Partner Marketing'`, `'250 Sales'`, `'252
 *     Revenue Operations'`, plus 1 other). **First cohort
 *     observation of departments-as-`<numeric-id> <name>`** —
 *     distinct from sweetgreen's run-314 store-location
 *     departments and Amplitude's run-317 `:`-separator
 *     functional sub-department naming. **Fifty-second cohort
 *     plugin** with fully-clean department pass-through.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/constantcontact/jobs';

@SourcePlugin({
  site: Site.CONSTANTCONTACT,
  name: 'Constant Contact',
  category: 'company',
})
@Injectable()
export class ConstantContactService implements IScraper {
  private readonly logger = new Logger(ConstantContactService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Constant Contact: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10 applied (trailing-pad form): 1/28 wire titles
        // padded (~3.6 %).
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
        const id = `constantcontact-${jobId}`;

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
            site: Site.CONSTANTCONTACT,
            title,
            // D-09 omitted: internal-whitespace wire asymmetry.
            companyName: listing.company_name ?? 'Constant Contact',
            // D-04: wire `absolute_url` flows through (variant 2
            // — canonical Greenhouse host); fallback uses the
            // same canonical variant-2 form.
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/constantcontact/jobs/${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            // D-11 omitted: 0/28 wire departments padded.
            department: listing.departments?.[0]?.name ?? null,
          }),
        );
      }

      this.logger.log(`Constant Contact: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Constant Contact scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
