import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * N26 GmbH — operator of the **dominant pan-European challenger-
 * bank platform pioneered around the mobile-first / app-only
 * personal-current-account data model on a German-banking-
 * licence base** (founded by Valentin Stalf and Maximilian
 * Tayenthal in February 2013 in Berlin (originally as Number26
 * referencing the Rubik's-cube 26-position metaphor; rebranded
 * to N26 in July 2016 after acquiring the BaFin / European
 * Central Bank full banking-licence in mid-2016); raised ~$1.7B
 * across rounds at peak ~$9B / €8B valuation in October 2021
 * led by Third Point Ventures and Coatue Management; ships
 * current accounts, joint accounts, savings accounts, and the
 * N26 Smart / N26 You / N26 Metal subscription tiers across
 * the EU challenger-bank segment — alongside competitors Monzo,
 * Revolut, Bunq, Wise, and bunq — with a hybrid distributed
 * workforce concentrated across Berlin (HQ), Barcelona, Vienna,
 * Paris, Milan, Madrid, and Remote across the European Union)
 * — publishes its consolidated careers board through Greenhouse
 * at the bare slug `n26` (the lowercase digit-suffixed brand-
 * stem; case-asymmetric ON THE LETTER ONLY with the wire
 * `company_name === 'N26'` 3-byte uppercase form — see Spec
 * 100 § 10 D-05).
 *
 * **Two structural deviations from the Epic Games (Spec 069)
 * template** — D-04 wire-shape variant 27 (NEW — first cohort
 * plugin to use variant 27; bare brand-domain `n26.com` +
 * locale-region single-segment prefix `/en-eu/` + `/careers/
 * positions/` path + path-id + query-id); D-09 omitted with
 * case-asymmetric all-caps-letter + digits short wire form
 * (vs Epic Games' multi-token internal-whitespace bare-brand
 * wire `'Epic Games'`).
 *
 *   1. **D-04 — wire-shape variant 27 (bare brand-domain
 *      locale-region-segment `/careers/positions/` path-id +
 *      query-id — first cohort observation).** N26 publishes
 *      `absolute_url` on
 *      `https://n26.com/en-eu/careers/positions/<id>?gh_jid=<id>`
 *      with four distinguishing sub-axes:
 *      a) **Bare brand-domain `n26.com`** — same as variants
 *         13 (Epic Games), 15 (Lattice), 18 (Bitwarden), 23
 *         (Benevity); distinct from variants 16/19/20/24/25
 *         (`www.`-prefixed) and variants 8/21/26 (careers-
 *         subdomain).
 *      b) **Locale-region single-segment prefix `/en-eu/`** —
 *         a SINGLE hyphenated path segment encoding a locale-
 *         and-region tag. **First cohort observation** of a
 *         hyphenated locale-region single-segment form;
 *         distinct from variant 21's single `/en/` (locale only)
 *         and variant 26's `/global/en/` (region-cluster +
 *         locale, two segments).
 *      c) **`/careers/positions/<id>` path-id form** — `/careers/`
 *         ancestor segment with `/positions/` parent and id-in-
 *         path. Same `/careers/`-prefix sub-axis as variants 13/
 *         18/19/20/22/23/25; first cohort observation of a
 *         `/positions/` parent segment (vs variants 13's
 *         `/jobs/`, 19's `/job/`, 20's `/job-post/`, 23's
 *         `/job-posting/`).
 *      d) **Path-id + query-id dual-id `?gh_jid=<id>`** — same
 *         dual-id form as variant 26 (HelloFresh) and variant
 *         13 (Epic Games); distinct from variant 24 (BILL's
 *         bare-id-and-query-id dual-id).
 *      **First** plugin in the cohort to use **wire-shape
 *      variant 27** — the **thirtieth distinct wire-shape
 *      variant**.
 *
 *      The plugin emits `listing.absolute_url` byte-for-byte.
 *      The **fallback** `jobUrl` constructor defaults to the
 *      canonical Greenhouse **variant-2** form
 *      `https://job-boards.greenhouse.io/n26/jobs/<id>`.
 *
 *   2. **D-09 — brand-name trim omitted with CASE-ASYMMETRIC
 *      ALL-CAPS-LETTER + DIGITS SHORT WIRE FORM.** Wire
 *      `company_name === 'N26'` byte-for-byte (3 bytes — fully
 *      clean; 0 of 47 padded). Slug `n26` is 3 bytes lowercase;
 *      case-asymmetric ON THE LETTER ONLY (`'N'` vs `'n'`) — the
 *      digits `26` are byte-identical between slug and wire.
 *      **First cohort observation** of a wire `company_name`
 *      that combines an uppercase letter with digits in a
 *      compact 3-byte form (BILL was the prior all-caps short
 *      wire form at 4 bytes but contained no digits). The
 *      plugin emits the wire byte-for-byte with a defensive
 *      `'N26'` fallback. **Forty-ninth cohort plugin to omit
 *      D-09**.
 *
 * Shared with Epic Games (Spec 069):
 *
 *   - **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     **Fifty-sixth** plugin to apply D-08.
 *
 *   - **D-10 — wire-title `.trim()` applied (trailing-pad form).**
 *     2 of 47 wire titles in the run-310 probe carry trailing
 *     ASCII-space padding (~4.3 % pad rate — close to Epic
 *     Games' ~2.7 % rate). **Twenty-sixth cohort plugin to
 *     apply D-10**.
 *
 *   - **D-11 — fully-clean department pass-through.** 0 of 47
 *     wire department names padded (`'Banking Operations'`,
 *     `'Business'`, `'Executive Office'`, `'Finance'`,
 *     `'Group Internal Audit'`, `'Legal'`, `'Marketing'`,
 *     `'Operations'`, plus 12 others — clean multi-token
 *     forms). **Forty-second cohort plugin** with fully-clean
 *     department pass-through.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/n26/jobs';

@SourcePlugin({
  site: Site.N26,
  name: 'N26',
  category: 'company',
})
@Injectable()
export class N26Service implements IScraper {
  private readonly logger = new Logger(N26Service.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`N26: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10 applied (trailing-pad form): 2/47 wire titles
        // padded (~4.3 %).
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
        const id = `n26-${jobId}`;

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
            site: Site.N26,
            title,
            // D-09 omitted: case-asymmetric all-caps-letter +
            // digits short wire form `'N26'` (3 bytes).
            companyName: listing.company_name ?? 'N26',
            // D-04: wire `absolute_url` flows through (variant 27
            // — bare brand-domain + locale-region single-segment
            // + `/careers/positions/` + path-id + query-id);
            // fallback uses canonical Greenhouse variant-2 form.
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/n26/jobs/${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            // D-11 omitted: 0/47 wire departments padded.
            department: listing.departments?.[0]?.name ?? null,
          }),
        );
      }

      this.logger.log(`N26: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`N26 scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
