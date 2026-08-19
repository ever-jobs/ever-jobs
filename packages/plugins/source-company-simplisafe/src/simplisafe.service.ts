import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * SimpliSafe Inc. — operator of the **dominant DIY wireless
 * home-security-as-a-service platform pioneered around the
 * self-install professionally-monitored security data model**
 * (founded by Chad Laurans and Eleanor Laurans in 2006 in
 * Boston, MA; private equity-backed since the 2018 Hellman &
 * Friedman buyout at ~$1B+ enterprise valuation; ships
 * SimpliSafe Wireless Home Security Systems, Outdoor Camera,
 * Smart Alarm Wireless Indoor Camera, Active Guard Outdoor
 * Protection, and Pro-Premium Monitoring across the
 * residential home-security / smart-home / professionally-
 * monitored-alarm vertical — alongside competitors ADT, Ring
 * (Amazon), Vivint, Brinks Home, and Frontpoint — with a
 * hybrid distributed workforce concentrated across Boston
 * (HQ), Manchester (UK), Richmond (VA manufacturing), and
 * Remote across the United States and the United Kingdom) —
 * publishes its consolidated careers board through Greenhouse
 * at the bare slug `simplisafe` (case-asymmetric with the
 * wire `company_name === 'SimpliSafe'` PascalCase concat —
 * same byte-count (10 bytes) but byte-distinct via case at
 * TWO indices: 0 (`S` vs `s`) and 6 (`S` vs `s`); see Spec
 * 171 § 10 D-09).
 *
 * **One structural deviation from the GoCardless (Spec 150)
 * template** — D-09 sub-axis only: caps-at-0/2 → caps-at-0/6
 * (TWO-cap PascalCase shape preserved; only the byte index of
 * the second capital shifts). **Fiftieth near-clean re-spin**
 * in run history. All five primary axes match GoCardless,
 * with a notable D-09 sub-axis observation:
 *
 *   - **D-04 — wire-shape variant 2 (canonical Greenhouse host).**
 *     `https://job-boards.greenhouse.io/simplisafe/jobs/<id>`.
 *     **Seventy-third** plugin in the cohort to use variant 2.
 *
 *   - **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     **One-hundred-and-twenty-seventh** plugin to apply D-08.
 *
 *   - **D-09 — brand-name trim omitted with TWO-cap PascalCase
 *     case-asymmetric wire form.** Wire `company_name ===
 *     'SimpliSafe'` byte-for-byte (10 bytes — fully clean;
 *     0 of 42 padded). Slug `simplisafe` is 10 bytes
 *     lowercase; case-asymmetric at TWO byte indices: 0 (`S`
 *     vs `s`) and 6 (`S` vs `s`). **8th cohort plugin with
 *     TWO-cap PascalCase D-09 sub-axis** after SoFi (caps
 *     0/2), StockX (caps 0/5), xAI (caps 0/2 lowercase
 *     first), LaunchDarkly (caps 0/6), PagerDuty (caps 0/5),
 *     ComplyAdvantage (caps 0/6), and GoCardless (caps 0/2).
 *     **Caps-at-0/6 matches LaunchDarkly (Spec 102) and
 *     ComplyAdvantage (Spec 141) exactly** — third cohort
 *     plugin with caps-at-0/6 sub-pattern. **One-hundred-
 *     and-eighteenth cohort plugin to omit D-09**.
 *
 *   - **D-10 — wire-title `.trim()` applied (trailing-pad form).**
 *     6 of 42 wire titles in the run-381 probe carry
 *     trailing ASCII-space padding (~14.3 % pad rate, all
 *     trailing-only — `'Customer Analytics Manager,
 *     Activations & Adoption '` (twice across two listings),
 *     `'ECommerce Growth Manager '`, `'Product Compliance
 *     Specialist '`, `'Senior Automation Engineer
 *     (Firmware) '`, `'Staff IAM Engineer '`). **Seventy-
 *     eighth cohort plugin to apply D-10**.
 *
 *   - **D-11 — fully-clean department pass-through.** 0 of 42
 *     wire department names padded across 8 unique
 *     departments (`'Customer Experience & Monitoring'`,
 *     `'Engineering'`, `'Enterprise Info Systems'`,
 *     `'Finance'`, `'IT & InfoSec'`, `'Manufacturing
 *     Operations & Logistics'`, `'Marketing'`, `'Product'`
 *     — clean multi-token forms with internal whitespace,
 *     ampersands, and slashes). Pass-through preserves
 *     byte-for-byte. **One-hundred-and-second cohort plugin**
 *     with fully-clean department pass-through.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/simplisafe/jobs';

@SourcePlugin({
  site: Site.SIMPLISAFE,
  name: 'SimpliSafe',
  category: 'company',
})
@Injectable()
export class SimplisafeService implements IScraper {
  private readonly logger = new Logger(SimplisafeService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`SimpliSafe: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10 applied (trailing-pad form): 6/42 wire titles
        // padded (~14.3 %).
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
        const id = `simplisafe-${jobId}`;

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
            site: Site.SIMPLISAFE,
            title,
            // D-09 omitted: TWO-cap PascalCase case-asymmetric
            // wire form 'SimpliSafe' (caps 0/6).
            companyName: listing.company_name ?? 'SimpliSafe',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/simplisafe/jobs/${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            // D-11 omitted: 0/42 wire departments padded.
            department: listing.departments?.[0]?.name ?? null,
          }),
        );
      }

      this.logger.log(`SimpliSafe: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`SimpliSafe scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
