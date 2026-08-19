import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Dollar Shave Club, Inc. — operator of the **dominant direct-
 * to-consumer men's grooming subscription platform pioneered
 * around the monthly-blade-shipment-and-personal-care data
 * model** (founded by Michael Dubin and Mark Levine in 2011 in
 * Venice, California; raised ~$163M across rounds led by
 * Venrock, Forerunner Ventures, and TCV; acquired by Unilever
 * in July 2016 for $1B; spun back out as an independent company
 * in October 2023 with Nexus Capital Management as the new
 * majority owner; now headquartered in Durham, North Carolina;
 * ships razors, shave products, and personal care under the DSC
 * brand across the men's grooming / D2C-personal-care segment —
 * alongside competitors Harry's, Gillette / Procter & Gamble,
 * Manscaped, and Bevel — with a hybrid distributed workforce
 * concentrated across Durham, NC and Remote across the United
 * States) — publishes its consolidated careers board through
 * Greenhouse at the bare slug `dollarshaveclub` (the lowercase
 * concatenated three-word brand-name; case-asymmetric AND
 * length-asymmetric with the wire `company_name === 'Dollar
 * Shave Club'`; see Spec 096 § 10 D-09). The wire `company_name`
 * is the literal three-token brand string `'Dollar Shave Club'`
 * byte-for-byte (17 bytes; slug `dollarshaveclub` is 15 bytes —
 * slug/wire-asymmetric, wire LONGER than slug by 2 bytes via the
 * two internal ASCII spaces at indices 6 and 12 between
 * `Dollar`, `Shave`, and `Club`).
 *
 * **Two structural deviations from the New Relic (Spec 085)
 * template** — D-10 omitted (New Relic applied with 16/74
 * ~21.6 % pad rate; Dollar Shave Club 0/5 wire titles padded
 * — fully clean); D-11 applied with single-trailing-space form
 * (New Relic omitted with 0/74 padded; Dollar Shave Club 1/5
 * padded `'Legal '` — first cohort plugin to combine D-11
 * application with D-09 internal-whitespace asymmetry).
 *
 *   1. **D-09 — brand-name trim omitted (THREE-token internal-
 *      whitespace asymmetry; first cohort observation of three-
 *      token form).** Wire `company_name === 'Dollar Shave
 *      Club'` byte-for-byte (17 bytes — three brand-tokens
 *      separated by two internal ASCII spaces). Slug/wire-
 *      asymmetric — wire 17 bytes vs slug 15 bytes (`dollarshaveclub`).
 *      All four prior internal-whitespace-asymmetry cases were
 *      two-token forms with a single internal space byte:
 *      Maven Clinic `'Maven Clinic'` (12 / 11), Stitch Fix
 *      `'Stitch Fix'` (10 / 9), Scale AI `'Scale AI'` (8 / 7),
 *      New Relic `'New Relic'` (9 / 8). Dollar Shave Club is
 *      the **first** cohort plugin to carry **two** internal
 *      space bytes in the wire form. The plugin emits the wire
 *      byte-for-byte; downstream cross-source dedup (if used)
 *      is responsible for canonicalising the whitespace-vs-
 *      concatenated axis. **Forty-fifth cohort plugin to omit
 *      D-09**, tenth slug/wire asymmetry case overall, fifth
 *      internal-whitespace asymmetry case, **first three-token
 *      internal-whitespace asymmetry**.
 *
 *   2. **D-10 — wire-title `.trim()` OMITTED.** 0 of 5 wire
 *      titles in the run-306 probe carry pad bytes (`'Brand
 *      Marketing Intern'`, `'Ecommerce Intern'`, `'Legal
 *      Intern'`, `'Senior Manager, Engineering'`, `'Social
 *      Media Growth Intern'` — all clean byte-for-byte forms).
 *      The plugin emits `listing.title` directly without a
 *      `.trim()`. **Nineteenth cohort plugin to omit D-10**.
 *
 *   3. **D-11 — wire-department `.trim()` APPLIED (single-
 *      trailing-space form).** 1 of 5 wire department names in
 *      the run-306 probe carries a trailing ASCII-space pad byte
 *      (`'Legal '` — the third listing's department; the other
 *      four — `'Brand Strategy & Marketing'` × 2, `'eCommerce
 *      - Digital'`, `'Engineering'` — are clean); ~20 % listing-
 *      level pad rate. The plugin applies `.trim()` to the
 *      wire `departments[0].name` before the search-term guard
 *      and emit, locking the trimmed form for search-term match
 *      consistency.
 *
 *      **Fifth cohort plugin to apply D-11** (after Lattice's
 *      run-284 first-ever trailing-pad, DataCamp's run-291
 *      first-ever leading-pad, Typeform's run-299 second
 *      trailing-pad, and BILL's run-302 high-pad-rate trailing-
 *      pad). Dollar Shave Club is the **first cohort plugin to
 *      ship D-11 application combined with D-09 internal-
 *      whitespace asymmetry** — all four prior D-11 applicants
 *      (Lattice `'Lattice'`, DataCamp `'DataCamp'`, Typeform
 *      `'Typeform'`, BILL `'BILL'`) carried single-token bare-
 *      brand wires that did not exercise the slug-vs-wire
 *      whitespace-asymmetry axis. The trim applies only to the
 *      `departments[0].name` axis, NOT the `company_name` axis
 *      (which preserves its three-token internal-whitespace
 *      form intact).
 *
 * Shared with New Relic:
 *
 *   - **D-04 — wire-shape variant 2 (canonical Greenhouse host).**
 *     `https://job-boards.greenhouse.io/dollarshaveclub/jobs/<id>`.
 *     **Twenty-fifth** plugin in the cohort to use variant 2.
 *
 *   - **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     Dollar Shave Club's `content` is HTML-entity-encoded
 *     (`&lt;p&gt;&lt;strong&gt;ABOUT DSC:&lt;/strong&gt;&lt;/p&gt;`).
 *     **Fifty-second** plugin to apply D-08.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/dollarshaveclub/jobs';

@SourcePlugin({
  site: Site.DOLLARSHAVECLUB,
  name: 'Dollar Shave Club',
  category: 'company',
})
@Injectable()
export class DollarShaveClubService implements IScraper {
  private readonly logger = new Logger(DollarShaveClubService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Dollar Shave Club: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10 omitted: 0/5 wire titles padded in run-306 probe
        // — no `.trim()` applied; wire pass-through. Defensive
        // null-coalesce keeps the empty-string fallback identical
        // to peer plugins.
        const title = listing.title ?? '';
        if (!title) continue;

        // D-11 applied (single-trailing-space form): 1 of 5 wire
        // departments in run #306 carries trailing-space padding
        // (`'Legal '`). Trim BEFORE the searchTerm guard so case-
        // insensitive department matches honour the trimmed form.
        const department = (listing.departments?.[0]?.name ?? '').trim() || null;

        if (input.searchTerm) {
          const term = input.searchTerm.toLowerCase();
          const titleMatch = title.toLowerCase().includes(term);
          const deptMatch = (department ?? '').toLowerCase().includes(term);
          if (!titleMatch && !deptMatch) continue;
        }

        const jobId = listing.id ?? '';
        const id = `dollarshaveclub-${jobId}`;

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
            site: Site.DOLLARSHAVECLUB,
            title,
            // D-09 omitted: THREE-token internal-whitespace-
            // asymmetric wire `company_name === 'Dollar Shave
            // Club'` byte-for-byte (17 bytes; 2 bytes longer
            // than slug `dollarshaveclub` via two internal ASCII
            // spaces at indices 6 and 12); pass-through with a
            // defensive `'Dollar Shave Club'` fallback.
            companyName: listing.company_name ?? 'Dollar Shave Club',
            // D-04: wire `absolute_url` flows through (variant 2
            // canonical Greenhouse host); fallback uses canonical
            // Greenhouse variant-2 form.
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/dollarshaveclub/jobs/${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            // D-11 applied (single-trailing-space form): trimmed
            // wire department; the wire pad bytes (1 of 5
            // listings — `'Legal '`) are stripped before emit.
            department,
          }),
        );
      }

      this.logger.log(`Dollar Shave Club: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Dollar Shave Club scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
