import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Amplitude, Inc. — operator of the **dominant digital-analytics
 * platform pioneered around the product-analytics +
 * behavioural-cohort + experimentation data model** (founded by
 * Spenser Skates, Curtis Liu, and Jeffrey Wang in 2012 in San
 * Francisco; Nasdaq-listed (AMPL) since September 2021 direct
 * listing at $4.6B initial valuation; expanded from product-
 * analytics to a full Digital Analytics Platform with Audiences,
 * Experiment, Recommend, CDP, and Session Replay; ships
 * Amplitude Free / Plus / Enterprise tiers across the product-
 * analytics / experimentation / digital-analytics segment —
 * alongside competitors Mixpanel, Heap, Pendo, FullStory,
 * Fullstack, and Posthog — with a hybrid distributed workforce
 * concentrated across San Francisco (HQ), New York, London,
 * Singapore, and Remote across the United States, UK, EU, and
 * APAC) — publishes its consolidated careers board through
 * Greenhouse at the bare slug `amplitude` (the lowercase brand
 * name; case-symmetric AFTER trim with the wire `company_name
 * === 'Amplitude '` 10-byte trailing-space-padded form — see
 * Spec 107 § 10 D-05 / D-09).
 *
 * **Two structural deviations from the Fivetran (Spec 082)
 * template** — D-04 sub-axis (Amplitude variant 2 vs Fivetran
 * variant 19); D-10 application (Amplitude applies trailing-
 * pad form vs Fivetran omits).
 *
 *   1. **D-09 — wire-`company_name` `.trim()` applied with
 *      TRAILING-space pad sub-axis.** All 60 wire `company_name`
 *      records carry a single trailing ASCII space —
 *      `'Amplitude '` byte-for-byte (10 bytes; trim → 9-byte
 *      `'Amplitude'`). 100 % pad rate. **Third cohort plugin
 *      to apply D-09** (after Fivetran's run-292 first-ever
 *      trailing-space `'Fivetran '` application and sweetgreen's
 *      run-314 leading-space `' sweetgreen'` application).
 *      **Second cohort observation of TRAILING-space D-09
 *      application** — confirms trailing-pad as a recurring sub-
 *      axis (Fivetran first, Amplitude second). The plugin
 *      applies `.trim()` to `listing.company_name` before emit
 *      so the emitted `companyName === 'Amplitude'` (9 bytes).
 *
 *   2. **D-04 — wire-shape variant 2 (canonical Greenhouse
 *      host).** `https://job-boards.greenhouse.io/amplitude/jobs/<id>`.
 *      **Thirty-second** plugin in the cohort to use variant 2.
 *      Distinct from Fivetran's variant 19 bare-brand-domain
 *      careers shape.
 *
 * Shared with Fivetran:
 *
 *   - **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     **Sixty-third** plugin to apply D-08.
 *
 *   - **D-10 — wire-title `.trim()` applied (trailing-pad form).**
 *     3 of 60 wire titles in the run-317 probe carry trailing
 *     ASCII-space padding (~5.0 % pad rate). **Thirty-first
 *     cohort plugin to apply D-10**.
 *
 *   - **D-11 — fully-clean department pass-through.** 0 of 60
 *     wire department names padded across 23 unique departments
 *     (`'Account Executives'`, `'Accounting'`, `'CFO :
 *     Accounting'`, `'CFO : Deal Desk and Sales Planning'`,
 *     `'CFO : Financial Planning'`, `'Corporate Marketing'`,
 *     `'Customer Success : CSA'`, `'Customer Success : TSM'`,
 *     plus 15 others — clean multi-token forms with internal
 *     whitespace and **`:` separator-token convention** — first
 *     cohort observation of `':'`-separated functional sub-
 *     department naming under D-11). **Forty-eighth cohort
 *     plugin** with fully-clean department pass-through.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/amplitude/jobs';

@SourcePlugin({
  site: Site.AMPLITUDE,
  name: 'Amplitude',
  category: 'company',
})
@Injectable()
export class AmplitudeService implements IScraper {
  private readonly logger = new Logger(AmplitudeService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Amplitude: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10 applied (trailing-pad form): 3/60 wire titles
        // padded (~5.0 %).
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
        const id = `amplitude-${jobId}`;

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
            site: Site.AMPLITUDE,
            title,
            // D-09 APPLIED (trailing-pad form): wire 'Amplitude '
            // 10 bytes → trim → 9-byte 'Amplitude'.
            companyName: (listing.company_name ?? 'Amplitude').trim(),
            // D-04: wire `absolute_url` flows through (variant 2
            // — canonical Greenhouse host); fallback uses the
            // same canonical variant-2 form.
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/amplitude/jobs/${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            // D-11 omitted: 0/60 wire departments padded.
            department: listing.departments?.[0]?.name ?? null,
          }),
        );
      }

      this.logger.log(`Amplitude: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Amplitude scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
