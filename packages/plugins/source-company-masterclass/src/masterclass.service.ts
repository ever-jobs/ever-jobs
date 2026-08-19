import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * MasterClass — operator of the dominant celebrity-led streaming
 * education platform pioneered around the premium video-class
 * masterclass-by-instructor data model (founded by David Rogier
 * and Aaron Rasmussen in 2015 in San Francisco; raised $469M+
 * across rounds led by Fidelity, Eldridge Industries, IVP,
 * Javelin Venture Partners, NEA, and NewView Capital at a peak
 * $2.75B valuation in 2021; ships an annual-subscription
 * streaming product across 200+ classes taught by top-tier
 * named instructors — alongside competitors Skillshare, Udemy,
 * Coursera, Domestika, and CreativeLive — with a hybrid
 * in-office / remote workforce concentrated across the United
 * States) — publishes its consolidated careers board through
 * Greenhouse at the bare slug `masterclass` (the lowercase
 * brand name; case-asymmetric with the wire `company_name`
 * which carries the brand's CamelCase form `'MasterClass'`;
 * see Spec 075 § 10 D-05). The wire `company_name` is the
 * literal CamelCase brand string `'MasterClass'` byte-for-byte
 * (11 bytes; slug `masterclass` is also 11 bytes — slug/wire
 * EQUAL-LENGTH but byte-distinct via case at byte index 6,
 * `c` vs `C`).
 *
 * **Two structural deviations from the Honeycomb (Spec 073)
 * template** —
 *
 *   - **D-09 omitted with case-only wire asymmetry.** Honeycomb's
 *     wire was `'Honeycomb.io'` (TLD-suffix asymmetry — wire 3
 *     bytes longer than slug). MasterClass's wire is
 *     `'MasterClass'` (case-only asymmetry — same byte length
 *     as slug, byte-distinct only via the internal capital `C`
 *     at index 6). **First cohort plugin where slug and wire
 *     are equal-byte-length but byte-distinct via case alone**
 *     — distinct from Ramp Network's brand-shortening
 *     asymmetry, Scale AI's internal-whitespace asymmetry,
 *     fuboTV's brand-rebrand truncation, and Honeycomb's
 *     TLD-suffix asymmetry. Twenty-fifth cohort plugin to omit
 *     D-09; fifth slug/wire asymmetry case overall, but the
 *     first equal-length-case-only asymmetry case.
 *
 *   - **D-10 omitted.** Honeycomb's wire titles were 2 of 10
 *     padded; MasterClass's run-285 probe shows 0 of 6 titles
 *     padded (the wire is fully clean). The plugin emits
 *     `listing.title` byte-for-byte without a `.trim()` —
 *     **twelfth cohort plugin to omit D-10** (after the prior
 *     fully-clean cohort).
 *
 * Shared with Honeycomb:
 *
 *   - **D-04 — wire-shape variant 2 fallback URL.** MasterClass's
 *     tenant publishes its `absolute_url` on the modern
 *     `https://job-boards.greenhouse.io/masterclass/jobs/<id>`
 *     shape — the **sixteenth** plugin in the cohort to use
 *     variant 2 (after Vercel, Affirm, Gusto, Mercury, Buildkite,
 *     Netlify, Postman, Webflow, Attentive, Intercom, Mixpanel,
 *     Scale AI, Cameo, Carta, and Honeycomb). The fallback
 *     `jobUrl` constructor mirrors this byte-for-byte.
 *
 *   - **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     Like every plugin from Klaviyo onwards, MasterClass's
 *     `content` is HTML-entity-encoded so the plugin decodes
 *     entities BEFORE stripping tags. **Thirty-first** plugin
 *     in the cohort to apply D-08.
 *
 *   - **D-11 — fully-clean department pass-through.** MasterClass's
 *     wire department names are 0 of 6 padded (0 % pad rate —
 *     `'Content Production'`, `'Marketing'` × 2, `'Content'`,
 *     `'Engineering'` × 2). The plugin emits the wire
 *     `departments[0].name` byte-for-byte without a `.trim()`
 *     (the pass-through is a no-op on the clean wire data;
 *     if MasterClass adds padding upstream in the future, the
 *     pass-through observability lock catches the diff in the
 *     unit tests).
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/masterclass/jobs';

@SourcePlugin({
  site: Site.MASTERCLASS,
  name: 'MasterClass',
  category: 'company',
})
@Injectable()
export class MasterclassService implements IScraper {
  private readonly logger = new Logger(MasterclassService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`MasterClass: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10 omitted: wire title is fully clean (0 of 6 padded
        // in run-285 probe); pass-through preserves byte-fidelity.
        const title = listing.title ?? '';
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
        const id = `masterclass-${jobId}`;

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
            site: Site.MASTERCLASS,
            title,
            // D-09 omitted: case-asymmetric wire `company_name` is
            // `'MasterClass'` byte-for-byte (CamelCase brand;
            // slug/wire equal-length but byte-distinct via case
            // alone at index 6). Pass-through with a defensive
            // `'MasterClass'` fallback locks the equal-length-
            // case-only asymmetry observable.
            companyName: listing.company_name ?? 'MasterClass',
            // D-04: variant-2 modern hosted-board fallback —
            // `job-boards.greenhouse.io/<slug>/jobs/<id>`.
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/masterclass/jobs/${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            // D-11: byte-for-byte pass-through of the wire department
            // name; the wire is fully clean (0 of 6 padded in run
            // #285 probe) so this is a no-op pass-through.
            department: listing.departments?.[0]?.name ?? null,
          }),
        );
      }

      this.logger.log(`MasterClass: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`MasterClass scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
