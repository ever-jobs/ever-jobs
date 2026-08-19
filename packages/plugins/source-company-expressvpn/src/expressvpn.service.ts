import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Express Technologies Ltd. (operating as ExpressVPN) —
 * operator of the **dominant consumer-VPN provider pioneered
 * around the TrustedServer RAM-only no-disk-write architecture**
 * (founded by Peter Burchhardt and Dan Pomerantz in 2009 in
 * the British Virgin Islands; acquired by Kape Technologies
 * in September 2021 for $936M; ships ExpressVPN VPN client
 * (Lightway protocol), Aircove (Wi-Fi router with VPN built-
 * in), and password-manager + identity-defender features
 * across the consumer-privacy / VPN-SaaS / consumer-
 * cybersecurity vertical — alongside competitors NordVPN,
 * Surfshark, ProtonVPN, and Mullvad — with a hybrid
 * distributed workforce concentrated across British Virgin
 * Islands (HQ), London, Hong Kong, Tortola, and Remote across
 * the United States, Europe, and APAC) — publishes its
 * consolidated careers board through Greenhouse at the bare
 * slug `expressvpn` (case-asymmetric with the wire
 * `company_name === 'ExpressVPN'` PascalCase concat — same
 * byte-count (10 bytes) but byte-distinct via case at FOUR
 * indices: 0 (`E` vs `e`), 7 (`V` vs `v`), 8 (`P` vs `p`),
 * and 9 (`N` vs `n`); caps at byte 7-8-9 form the embedded
 * 3-letter acronym `VPN` at the tail. See Spec 145 § 10
 * D-09).
 *
 * **One structural deviation from the PagerDuty (Spec 117)
 * template** — D-09 sub-axis (PagerDuty TWO-cap PascalCase
 * caps 0/5 → ExpressVPN FIRST-COHORT FOUR-cap PascalCase
 * caps 0/7/8/9 forming embedded 3-letter acronym `VPN`).
 *
 *   - **D-04 — wire-shape variant 2 (canonical Greenhouse host).**
 *     `https://job-boards.greenhouse.io/expressvpn/jobs/<id>`.
 *     **Fifty-fifth** plugin in the cohort to use variant 2.
 *
 *   - **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     **One-hundred-and-first** plugin to apply D-08.
 *
 *   - **D-09 — brand-name trim omitted with FIRST-COHORT
 *     FOUR-cap PascalCase case-asymmetric wire form.** Wire
 *     `company_name === 'ExpressVPN'` byte-for-byte (10 bytes
 *     — fully clean; 0 of 29 padded). Slug `expressvpn` is
 *     10 bytes lowercase; case-asymmetric at FOUR byte
 *     indices: 0 (`E` vs `e`), 7 (`V` vs `v`), 8 (`P` vs
 *     `p`), 9 (`N` vs `n`). Caps at 7-8-9 form the embedded
 *     3-letter acronym `VPN` at the tail. **First cohort
 *     observation of FOUR-cap PascalCase D-09 sub-axis** —
 *     distinct from prior TWO-cap forms (SoFi caps 0/2,
 *     StockX caps 0/5, xAI caps 0/2 lowercase first,
 *     LaunchDarkly caps 0/6, PagerDuty caps 0/5,
 *     ComplyAdvantage caps 0/6) and prior THREE-cap forms
 *     (AssemblyAI caps 0/8/9 forming `AI`, BigID caps 0/3/4
 *     forming `ID`). ExpressVPN's caps form a 3-letter
 *     acronym `VPN` rather than 2-letter. **Ninth PascalCase
 *     case-asymmetric plugin overall** in the cohort.
 *     **Ninety-second cohort plugin to omit D-09**.
 *
 *   - **D-10 — wire-title `.trim()` applied (trailing-pad form).**
 *     3 of 29 wire titles in the run-355 probe carry trailing
 *     padding (~10.3 % pad rate, all trailing-only) — 2
 *     ASCII-space pads (`'Senior UX Designer '`, `'UX Growth
 *     Designer '`) + **1 mojibake-NBSP pad** (`'Customer
 *     Success Data Lead Â '` carries `c3 82 c2 a0` byte
 *     sequence — wire-side double-UTF-8-encoded U+00A0 NBSP).
 *     **Second cohort observation of mojibake-NBSP pad form**
 *     after Bloomreach (Spec 139, run #349). JavaScript
 *     `.trim()` includes U+00A0 NBSP in its `WhiteSpace` set
 *     so the trailing NBSP is stripped; the residual mojibake
 *     `Â` (U+00C2) byte remains by-design — wire-faithful.
 *     **Sixty-second cohort plugin to apply D-10**.
 *
 *   - **D-11 — fully-clean department pass-through.** 0 of 29
 *     wire department names padded across 7 unique departments
 *     (`'Business Operations'`, `'Data Engineering & Insights'`,
 *     `'Design'`, `'Engineering'`, `'Marketing'`, `'Product
 *     Marketing'`, `'Security'` — clean multi-token forms
 *     with internal whitespace and ampersands). Pass-through
 *     preserves byte-for-byte. **Eighty-first cohort plugin**
 *     with fully-clean department pass-through.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/expressvpn/jobs';

@SourcePlugin({
  site: Site.EXPRESSVPN,
  name: 'ExpressVPN',
  category: 'company',
})
@Injectable()
export class ExpressvpnService implements IScraper {
  private readonly logger = new Logger(ExpressvpnService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`ExpressVPN: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10 applied (trailing-pad form): 3/29 wire titles
        // padded (~10.3 %); 1 sample carries mojibake-NBSP
        // (`c3 82 c2 a0`) — `.trim()` strips trailing NBSP,
        // wire-faithful `Â` remains.
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
        const id = `expressvpn-${jobId}`;

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
            site: Site.EXPRESSVPN,
            title,
            // D-09 omitted: FOUR-cap PascalCase case-asymmetric
            // wire form 'ExpressVPN' (caps 0/7/8/9 forming `VPN`).
            companyName: listing.company_name ?? 'ExpressVPN',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/expressvpn/jobs/${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            // D-11 omitted: 0/29 wire departments padded.
            department: listing.departments?.[0]?.name ?? null,
          }),
        );
      }

      this.logger.log(`ExpressVPN: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`ExpressVPN scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
