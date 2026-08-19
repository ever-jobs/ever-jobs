import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Oscar Insurance Corporation (Oscar Health, Inc., dba Hi
 * Oscar) — operator of the **dominant US-tech-first health-
 * insurance-as-a-platform pioneered around the member-
 * experience-as-software / +Oscar API-driven underwriting /
 * risk-bearing-tech-broker data model** (founded by Mario
 * Schlosser, Joshua Kushner, and Kevin Nazemi in 2012 in
 * New York City; public on the NYSE since March 2021 IPO
 * under ticker `OSCR` at ~$7.9B initial valuation; ships
 * Oscar Health (ACA Marketplace + Medicare Advantage +
 * Cigna+Oscar SMB partnership), +Oscar (the API-based
 * platform sold B2B), Oscar Concierge (member-experience
 * hub), Oscar Provider Network, and Oscar Virtual Care
 * across the tech-first-health-insurance / risk-bearing-
 * payvider / Medicare-Advantage segment — alongside
 * competitors Bright Health, Clover Health, Devoted Health,
 * Alignment Healthcare, Cigna, UnitedHealth, Humana, and
 * Anthem — with a hybrid distributed workforce concentrated
 * across New York City (HQ), Tempe, Los Angeles, and Remote
 * across the United States) — publishes its consolidated
 * careers board through Greenhouse at the bare slug `oscar`
 * (the lowercase 5-byte slug; **first-cohort slug-extra-word
 * asymmetric** vs the wire `company_name === 'Oscar Health'`
 * — slug 5 bytes vs wire 12 bytes; wire adds the entire
 * second token `' Health'` beyond the slug).
 *
 * **Two structural deviations from the Squarespace (Spec 088)
 * template** — D-04 sub-axis (variant 22 → variant 35) AND
 * D-09 sub-axis (Squarespace case-symmetric → Oscar first-
 * cohort slug-extra-word asymmetric).
 *
 *   1. **D-04 — wire-shape variant 35 (HTTP-scheme `www.`-
 *      prefixed parent-domain `hioscar.com` `/careers/<id>`
 *      id-in-path + gh_jid query — first cohort observation).**
 *      Oscar publishes its `absolute_url` on a **previously-
 *      unobserved** shape
 *      `http://www.hioscar.com/careers/<id>?gh_jid=<id>` with
 *      four sub-axes:
 *      a) **HTTP scheme** (second cohort observation after
 *         Squarespace's variant 22).
 *      b) **`www.`-prefixed parent-domain `hioscar.com`** —
 *         distinct from the `oscar.com` slug-matching
 *         expectation.
 *      c) **`/careers/<id>` path** — distinct from
 *         Squarespace's `/about/careers`.
 *      d) **Id-in-path + gh_jid query (dual-id form)** — same
 *         dual-id pattern as Okta's variant 31 / ClassPass's
 *         variant 12.
 *      **First** plugin in the cohort to use **wire-shape
 *      variant 35** — the **thirty-eighth distinct wire-
 *      shape variant** in the company-direct cohort.
 *
 *      The plugin emits `listing.absolute_url` byte-for-byte
 *      including the HTTP scheme; the **fallback** `jobUrl`
 *      constructor defaults to the canonical Greenhouse
 *      **variant-2** form (HTTPS)
 *      `https://job-boards.greenhouse.io/oscar/jobs/<id>`.
 *
 *   2. **D-09 — brand-name trim omitted with FIRST-COHORT
 *      slug-extra-word asymmetric wire form.** Slug `oscar`
 *      (5 bytes) vs wire `'Oscar Health'` (12 bytes — wire
 *      adds the entire second token `' Health'` beyond the
 *      slug). **Distinct from prior internal-whitespace
 *      asymmetry cases** (Scale AI / Maven Clinic / Stitch
 *      Fix / New Relic / Dollar Shave Club / Misfits Market
 *      / Constant Contact / Modern Health) which all had
 *      the same letters split by a space — Oscar's wire has
 *      an entire extra word the slug lacks. **Eightieth
 *      cohort plugin to omit D-09 — crosses the 80-plugin
 *      D-09-omission threshold at this run.**
 *
 * Shared with Squarespace:
 *
 *   - **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     **Eighty-ninth** plugin to apply D-08.
 *
 *   - **D-10 — wire-title `.trim()` applied with second-cohort
 *     leading-pad observation.** 2 of 247 wire titles in the
 *     run-343 probe carry pad bytes (~0.81 % pad rate —
 *     **lowest D-10 pad rate in cohort to date**) — 1
 *     trailing-pad (`'Senior Analyst, Data Analytics, SIU '`)
 *     + 1 **leading-pad** (`' Member & Provider Escalations
 *     Team Lead'`). **Second cohort observation of leading-
 *     pad title form** after Chainguard (Spec 122). The
 *     plugin's `.trim()` handles both directions
 *     transparently. **Fifty-third cohort plugin to apply
 *     D-10**.
 *
 *   - **D-11 — fully-clean department pass-through.** 0 of
 *     247 wire department names padded across 23 unique
 *     departments (`'Actuarial'`, `'Business Operations'`,
 *     `'Clinical'`, `'Compliance'`, `'Corporate Strategy'`,
 *     `'Data'`, `'Engineering'`, `'Finance'`, `'Insurance
 *     Operations'`, `'Insurance Product Strategy'`, `'Legal'`,
 *     `'Market P&L'`, plus 11 others — clean multi-token
 *     forms with internal whitespace and ampersands).
 *     **Seventy-first cohort plugin** with fully-clean
 *     department pass-through.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/oscar/jobs';

@SourcePlugin({
  site: Site.OSCAR,
  name: 'Oscar Health',
  category: 'company',
})
@Injectable()
export class OscarService implements IScraper {
  private readonly logger = new Logger(OscarService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Oscar: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10 applied with second-cohort leading-pad
        // observation: 2/247 wire titles padded (~0.81 %);
        // 1 trailing + 1 leading. `.trim()` strips both.
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
        const id = `oscar-${jobId}`;

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
            site: Site.OSCAR,
            title,
            // D-09 omitted: first-cohort slug-extra-word
            // asymmetric wire form 'Oscar Health' (12 bytes
            // vs slug 'oscar' 5 bytes — wire adds entire
            // second token).
            companyName: listing.company_name ?? 'Oscar Health',
            // D-04: wire `absolute_url` flows through (variant
            // 35 — HTTP `www.hioscar.com/careers/<id>?gh_jid=<id>`
            // dual-id form). Fallback uses canonical
            // Greenhouse variant-2 (HTTPS).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/oscar/jobs/${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            // D-11 omitted: 0/247 wire departments padded.
            department: listing.departments?.[0]?.name ?? null,
          }),
        );
      }

      this.logger.log(`Oscar: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Oscar scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
