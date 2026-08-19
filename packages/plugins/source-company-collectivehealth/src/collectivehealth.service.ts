import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Collective Health, Inc. — operator of the **integrated
 * employer-sponsored health-benefits platform pioneered
 * around the unified-claims-and-care-navigation data model**
 * (founded by Ali Diab and Rajaie Batniji in 2013 in San
 * Francisco, CA; private since the 2024 Series F round at
 * ~$1.5B unicorn valuation; ships Collective Health Member
 * Experience (claims + navigation + care-routing), Premier
 * Partner Network (carve-out vendor marketplace), and
 * Collective Health Care Concierge across the employer-
 * health-benefits / integrated-benefits-admin / digital-
 * care-navigation vertical — alongside competitors Lyra
 * Health, Hinge Health, Carrum Health, Maven Clinic, and
 * Included Health — with a hybrid distributed workforce
 * concentrated across San Francisco (HQ), Lehi UT, and
 * Remote across the United States) — publishes its
 * consolidated careers board through Greenhouse at the bare
 * slug `collectivehealth` (case-asymmetric vs the wire
 * `company_name === 'Collective Health'` — two-token brand
 * with internal ASCII space at byte index 10; case-AND-
 * length-asymmetric vs the lowercase 16-byte concatenated
 * slug `collectivehealth`; see Spec 155 § 10 D-09).
 *
 * **Two structural deviations from the Cribl (Spec 143)
 * template** — D-04 sub-axis (variant 38 → variant 42 first
 * cohort observation) AND D-09 sub-axis (case-symmetric →
 * internal-whitespace asymmetric).
 *
 *   - **D-04 — wire-shape variant 42 (`jobs.` subdomain
 *     `/apply/` query-only-id — first cohort observation).**
 *     Collective Health publishes `absolute_url` on
 *     `https://jobs.collectivehealth.com/apply/?gh_jid=<id>`
 *     — HTTPS + `jobs.` subdomain prefix + `/apply/`
 *     trailing-slash leaf with NO `/careers/` ancestor +
 *     query-only-id. **First cohort observation of `jobs.`
 *     subdomain prefix** — distinct from prior `careers.`
 *     subdomain (variants 26 / 40) and `www.` brand-domain
 *     variants. The **forty-fifth distinct wire-shape
 *     variant** in the company-direct cohort.
 *
 *     The plugin emits `listing.absolute_url` byte-for-byte.
 *     The **fallback** `jobUrl` constructor defaults to the
 *     canonical Greenhouse **variant-2** form
 *     `https://job-boards.greenhouse.io/collectivehealth/jobs/<id>`.
 *
 *   - **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     **One-hundred-and-eleventh** plugin to apply D-08.
 *
 *   - **D-09 — brand-name trim omitted with internal-
 *     whitespace asymmetric wire form.** Wire `company_name
 *     === 'Collective Health'` byte-for-byte (17 bytes —
 *     two-token brand with internal ASCII space at byte
 *     index 10; case-AND-length-asymmetric vs the lowercase
 *     16-byte concatenated slug `collectivehealth`); 0 of 14
 *     padded. **Ninth internal-whitespace asymmetry case**
 *     in the cohort after Scale AI / Maven Clinic / Stitch
 *     Fix / New Relic / Dollar Shave Club / Misfits Market /
 *     Constant Contact / Modern Health. **One-hundred-and-
 *     second cohort plugin to omit D-09**.
 *
 *   - **D-10 — wire-title `.trim()` omitted.** 0 of 14 wire
 *     titles in the run-365 probe carry pad bytes. The plugin
 *     emits `listing.title` byte-for-byte without a `.trim()`.
 *     **Thirty-first cohort plugin to omit D-10**.
 *
 *   - **D-11 — fully-clean department pass-through.** 0 of 14
 *     wire department names padded across 7 unique
 *     departments (`'Client Success'`, `'Contractors'`,
 *     `'Engineering'`, `'Financial Planning & Analysis'`,
 *     `'Health Plan Operations'`, `'Legal'`, `'Marketing'`).
 *     Pass-through preserves byte-for-byte. **Eighty-ninth
 *     cohort plugin** with fully-clean department pass-
 *     through.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/collectivehealth/jobs';

@SourcePlugin({
  site: Site.COLLECTIVEHEALTH,
  name: 'Collective Health',
  category: 'company',
})
@Injectable()
export class CollectiveHealthService implements IScraper {
  private readonly logger = new Logger(CollectiveHealthService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Collective Health: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10 omitted: 0/14 wire titles padded (no .trim()
        // applied — wire is fully clean).
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
        const id = `collectivehealth-${jobId}`;

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
            site: Site.COLLECTIVEHEALTH,
            title,
            // D-09 omitted: internal-whitespace asymmetric
            // wire `'Collective Health'` (17 bytes / 16-byte
            // slug).
            companyName: listing.company_name ?? 'Collective Health',
            // D-04: wire `absolute_url` flows through (variant 42).
            // Fallback uses canonical Greenhouse variant-2 form.
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/collectivehealth/jobs/${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            // D-11 omitted: 0/14 wire departments padded.
            department: listing.departments?.[0]?.name ?? null,
          }),
        );
      }

      this.logger.log(`Collective Health: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Collective Health scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
