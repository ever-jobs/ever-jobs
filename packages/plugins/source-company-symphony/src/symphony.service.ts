import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Symphony Communication Services LLC — operator of the
 * **dominant institutional-grade encrypted-collaboration-as-
 * a-service platform pioneered around the financial-services
 * secure-messaging data model** (founded by a Goldman Sachs
 * / JPMorgan / Bank of America / BlackRock / BNY Mellon /
 * Citadel / Citi / Credit Suisse / Deutsche Bank / HSBC /
 * Jefferies / Maverick Capital / Morgan Stanley / Nomura /
 * Wells Fargo consortium in 2014 in Palo Alto, CA after the
 * 2014 acquisition of the Perzo encrypted-messaging
 * platform; private since the 2019 Standard Industries /
 * Lakestar Series E round at $1.4B unicorn valuation; ships
 * Symphony Messaging, Voice Collaboration, Symphony Markets
 * (Cloud9 voice trading), and Symphony Manage across the
 * institutional-finance / front-office-trading / encrypted-
 * collaboration vertical — alongside competitors Bloomberg
 * Chat / Bloomberg IB, Microsoft Teams, Refinitiv Eikon
 * Messenger, Slack, ICE Chat, and FactSet Connect — with a
 * hybrid distributed workforce concentrated across Palo Alto
 * (HQ), New York City, London, Singapore, Sophia Antipolis
 * (France), Belfast, and Remote across the United States,
 * EMEA, and APAC) — publishes its consolidated careers board
 * through Greenhouse at the bare slug `symphony` (case-
 * asymmetric with the wire `company_name === 'Symphony
 * Communication Services'` — slug truncates the wire to the
 * first token only; see Spec 172 § 10 D-09).
 *
 * **Two structural deviations from the Descope (Spec 125)
 * template** — D-04 sub-axis (variant 2 → NEW variant 45
 * first cohort observation) AND D-09 sub-axis (case-
 * symmetric bare brand → fifth-cohort slug-truncation multi-
 * token corp-suffix descriptive entity wire form). The trim
 * semantics remain unchanged.
 *
 *   - **D-04 — NEW wire-shape variant 45 (first cohort
 *     observation).** `https://symphony.com/company/apply?gh_jid=<id>`
 *     — HTTPS + bare brand-domain `.com` (no `www.`) +
 *     2-segment `/company/apply` apply-page path + query-
 *     only `?gh_jid=<id>` form. The **forty-eighth distinct
 *     wire-shape variant** in the company-direct cohort
 *     (after Samsara variant 44 at Spec 168). The plugin
 *     emits `listing.absolute_url` byte-for-byte; the
 *     fallback constructor (when the wire omits
 *     `absolute_url`) defaults to the canonical Greenhouse
 *     variant-2 form `https://job-boards.greenhouse.io/symphony/jobs/<id>`
 *     because the variant-45 vanity-domain shape may not be
 *     guaranteed-resolvable for all listing IDs (same
 *     fallback strategy as Samsara / Klaviyo / Bird /
 *     Collective Health / Netskope).
 *
 *   - **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     **One-hundred-and-twenty-eighth** plugin to apply D-08.
 *
 *   - **D-09 — brand-name trim omitted with FIFTH-COHORT
 *     slug-truncation asymmetric wire form.** Wire
 *     `company_name === 'Symphony Communication Services'`
 *     byte-for-byte (31 bytes — three-token corp-suffix
 *     descriptive entity name with two internal ASCII
 *     whitespace bytes). Slug `symphony` is 8 bytes
 *     lowercase — matches the first wire token only;
 *     truncates 2 trailing tokens (`Communication
 *     Services`). **Fifth cohort observation of slug-
 *     truncation D-09 sub-axis** after Oscar (Spec 133 —
 *     slug-extra-word, 1 token added), BEAM (Spec 136 —
 *     slug-acronym-expansion), Founders (Spec 148 — 4 tokens
 *     dropped), and Fox (Spec 149 — 5 tokens dropped).
 *     **Symphony drops 2 trailing tokens** — the shortest
 *     non-zero token-truncation factor in the cohort to
 *     date. **One-hundred-and-nineteenth cohort plugin to
 *     omit D-09**.
 *
 *   - **D-10 — wire-title `.trim()` omitted.** 0 of 16 wire
 *     titles in the run-382 probe carry pad bytes. The
 *     plugin emits `listing.title` byte-for-byte without a
 *     `.trim()`. **Thirty-eighth cohort plugin to omit
 *     D-10**.
 *
 *   - **D-11 — `departments[0].name` `.trim()` applied
 *     (trailing-pad form).** 1 of 6 unique wire department
 *     names padded (`'Customer Experience '`); the plugin
 *     applies `.trim()` to the wire `departments[0].name`
 *     byte-for-byte before downstream emit. **Twentieth
 *     cohort plugin to apply D-11**. The remaining 5 unique
 *     department names are clean (`'Business Operations'`,
 *     `'Engineering'`, `'Human Resources'`, `'Product
 *     Management'`, `'Sales and Account Management'`).
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/symphony/jobs';

@SourcePlugin({
  site: Site.SYMPHONY,
  name: 'Symphony Communication Services',
  category: 'company',
})
@Injectable()
export class SymphonyService implements IScraper {
  private readonly logger = new Logger(SymphonyService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Symphony: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10 omitted: 0/16 wire titles padded; pass-through
        // byte-for-byte.
        const title = listing.title ?? '';
        if (!title) continue;

        // D-11 applied (trailing-pad form): 1/6 unique
        // wire dept names padded (`'Customer Experience '`).
        const dept = (listing.departments?.[0]?.name ?? '').trim() || null;

        if (input.searchTerm) {
          const term = input.searchTerm.toLowerCase();
          const titleMatch = title.toLowerCase().includes(term);
          const deptMatch = (dept ?? '').toLowerCase().includes(term);
          if (!titleMatch && !deptMatch) continue;
        }

        const jobId = listing.id ?? '';
        const id = `symphony-${jobId}`;

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
            site: Site.SYMPHONY,
            title,
            // D-09 omitted: fifth-cohort slug-truncation wire
            // form `'Symphony Communication Services'`.
            companyName: listing.company_name ?? 'Symphony Communication Services',
            // D-04: wire `absolute_url` flows through (NEW
            // variant 45); fallback defaults to canonical
            // variant-2 Greenhouse form because the variant-45
            // vanity-domain shape may not be guaranteed-
            // resolvable for all listing IDs (same fallback as
            // Samsara / Klaviyo / Bird / Collective Health /
            // Netskope).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/symphony/jobs/${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            department: dept,
          }),
        );
      }

      this.logger.log(`Symphony: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Symphony scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
