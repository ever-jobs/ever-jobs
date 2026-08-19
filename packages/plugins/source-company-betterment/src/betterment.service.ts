import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Betterment LLC — operator of the **dominant robo-advisor /
 * goal-based-investing platform pioneered around the
 * automated-ETF-portfolio-rebalancing-as-a-service data model**
 * (founded by Jon Stein and Eli Broverman in 2008 in New York
 * City; private; raised ~$435M across rounds at peak ~$1.3B
 * valuation in September 2021 led by Treasury and Aflac
 * Ventures; ships Betterment Investing (taxable + retirement
 * accounts), Betterment Cash Reserve / Checking, Betterment at
 * Work (workplace 401(k) / financial wellness for SMB / mid-
 * market employers), and Betterment Premium (CFP-advised
 * service tier) across the robo-advisor / digital-wealth /
 * goal-based-investing segment — alongside competitors
 * Wealthfront, Vanguard Personal Advisor Services, Charles
 * Schwab Intelligent Portfolios, M1 Finance, SoFi Invest, and
 * Acorns — with a hybrid distributed workforce concentrated
 * across New York City (HQ) and Remote across the United
 * States) — publishes its consolidated careers board through
 * Greenhouse at the bare slug `betterment` (case-symmetric
 * with the wire `company_name === 'Betterment'`; see Spec 120
 * § 10 D-05).
 *
 * **Two structural deviations from the Elastic (Spec 060)
 * template** — D-04 sub-axis (variant 11 → variant 32, both
 * duplicate-gh_jid forms but distinct host/path) AND D-11
 * applied (Elastic D-11 omitted; Betterment D-11 applied with
 * trailing-pad on `'Customer Experience '`).
 *
 *   1. **D-04 — wire-shape variant 32 (HTTPS-scheme `www.`-
 *      prefixed brand-domain `/careers/current-openings/job`
 *      duplicate-gh_jid query — first cohort observation).**
 *      Betterment publishes its `absolute_url` on a **previously-
 *      unobserved** shape
 *      `https://www.betterment.com/careers/current-openings/job?gh_jid=<id>&gh_jid=<id>`
 *      with four sub-axes:
 *      a) **HTTPS scheme.**
 *      b) **`www.`-prefixed brand-domain** (vs Elastic's
 *         `jobs.elastic.co` vanity-subdomain).
 *      c) **`/careers/current-openings/job` path** (vs
 *         Elastic's `/jobs`).
 *      d) **Duplicate `gh_jid` query parameter (same value
 *         repeated literally)** — same wire-form pattern as
 *         Elastic variant 11. **Second cohort observation of
 *         the duplicate-gh_jid wire form**.
 *      **First** plugin in the cohort to use **wire-shape
 *      variant 32** — the **thirty-fifth distinct wire-shape
 *      variant** in the company-direct cohort.
 *
 *      The plugin emits `listing.absolute_url` byte-for-byte
 *      including the duplicate-gh_jid query; the **fallback**
 *      `jobUrl` constructor defaults to the canonical
 *      Greenhouse **variant-2** form
 *      `https://job-boards.greenhouse.io/betterment/jobs/<id>`.
 *
 *   2. **D-11 — wire-department `.trim()` APPLIED (trailing-
 *      pad form).** 1 of 11 unique wire department names
 *      padded (`'Customer Experience '`); listing-level pad
 *      rate 3 of 31 (~9.7 %) — the plugin applies `.trim()`
 *      to the wire `departments[0].name` byte-for-byte
 *      before downstream emit. **Tenth cohort plugin to apply
 *      D-11**.
 *
 * Shared with Elastic:
 *
 *   - **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     **Seventy-sixth** plugin to apply D-08.
 *
 *   - **D-09 — brand-name trim omitted (case-symmetric).** Wire
 *     `company_name === 'Betterment'` byte-for-byte (10 bytes
 *     — fully clean, case-symmetric with the lowercase 10-byte
 *     slug `betterment`). **Sixty-seventh cohort plugin to omit
 *     D-09**.
 *
 *   - **D-10 — wire-title `.trim()` applied (trailing-pad form).**
 *     5 of 31 wire titles in the run-330 probe carry trailing
 *     ASCII-space padding (~16 % pad rate; e.g. `'Business
 *     Development Representative '`, `'Sr. Accounting Manager '`,
 *     `'Sr. CX Programs & Automation Manager '`). All trailing-
 *     only. **Forty-third cohort plugin to apply D-10**.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/betterment/jobs';

@SourcePlugin({
  site: Site.BETTERMENT,
  name: 'Betterment',
  category: 'company',
})
@Injectable()
export class BettermentService implements IScraper {
  private readonly logger = new Logger(BettermentService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Betterment: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10 applied (trailing-pad form): 5/31 wire titles
        // padded (~16 %).
        const title = (listing.title ?? '').trim();
        if (!title) continue;

        // D-11 applied (trailing-pad form): trim wire dept
        // name to handle 'Customer Experience '.
        const dept = (listing.departments?.[0]?.name ?? '').trim() || null;

        if (input.searchTerm) {
          const term = input.searchTerm.toLowerCase();
          const titleMatch = title.toLowerCase().includes(term);
          const deptMatch = (dept ?? '').toLowerCase().includes(term);
          if (!titleMatch && !deptMatch) continue;
        }

        const jobId = listing.id ?? '';
        const id = `betterment-${jobId}`;

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
            site: Site.BETTERMENT,
            title,
            // D-09 omitted: case-symmetric bare-brand wire.
            companyName: listing.company_name ?? 'Betterment',
            // D-04: wire `absolute_url` flows through (variant
            // 32 — HTTPS `www.betterment.com/careers/current-
            // openings/job?gh_jid=<id>&gh_jid=<id>` duplicate-
            // gh_jid form). Fallback uses canonical Greenhouse
            // variant-2.
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/betterment/jobs/${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            // D-11 applied: trim wire dept (3/31 listings carry
            // padded `'Customer Experience '`).
            department: dept,
          }),
        );
      }

      this.logger.log(`Betterment: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Betterment scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
