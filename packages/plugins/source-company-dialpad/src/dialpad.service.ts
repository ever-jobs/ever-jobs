import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Dialpad, Inc. — operator of the **dominant AI-native
 * business-communications platform pioneered around the
 * unified-AI-voice-meetings-messaging-contact-center data
 * model** (founded by Craig Walker in 2011 in San Francisco;
 * raised ~$415M across rounds at peak ~$2.2B valuation in
 * December 2021 led by ICONIQ Capital and OMERS Growth Equity;
 * ships Dialpad Ai Voice (business phone), Ai Meetings, Ai
 * Sales, Ai Contact Center, TalkIQ-derived real-time-
 * transcription / sentiment, and Dialpad Ai Recap across the
 * AI-business-communications / UCaaS / CCaaS / contact-center
 * segment — alongside competitors RingCentral, 8x8, Cisco
 * Webex, Zoom Phone, Microsoft Teams Phone, Vonage, and
 * Twilio Flex — with a hybrid distributed workforce
 * concentrated across San Francisco (HQ), Vancouver BC, Tokyo,
 * London, Bangalore, Tel Aviv, and Remote across the United
 * States, Canada, the United Kingdom, the European Union,
 * Japan, Israel, and the Asia-Pacific region) — publishes its
 * consolidated careers board through Greenhouse at the bare
 * slug `dialpad` (case-symmetric with the wire `company_name
 * === 'Dialpad'`; see Spec 126 § 10 D-05).
 *
 * **Zero structural deviations from the Branch (Spec 121)
 * template** — making this the **twenty-eighth** Greenhouse-
 * only company-direct plugin in run-history to ship as a
 * clean re-spin. All five primary axes share with Branch,
 * with a **first-cohort D-11 sub-axis observation** (numeric-
 * prefix-with-hyphen-separator dept naming):
 *
 *   - **D-04 — wire-shape variant 2 (canonical Greenhouse host).**
 *     `https://job-boards.greenhouse.io/dialpad/jobs/<id>`.
 *     **Forty-fifth** plugin in the cohort to use variant 2.
 *
 *   - **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     **Eighty-second** plugin to apply D-08.
 *
 *   - **D-09 — brand-name trim omitted (case-symmetric).** Wire
 *     `company_name === 'Dialpad'` byte-for-byte (7 bytes —
 *     fully clean, case-symmetric with the lowercase 7-byte
 *     slug `dialpad`). **Seventy-third cohort plugin to omit
 *     D-09**.
 *
 *   - **D-10 — wire-title `.trim()` omitted.** 0 of 86 wire
 *     titles padded; the plugin emits `listing.title` byte-
 *     for-byte without a `.trim()`. **Twenty-fifth cohort
 *     plugin to omit D-10**.
 *
 *   - **D-11 — fully-clean department pass-through with
 *     FIRST-COHORT numeric-prefix-with-hyphen-separator dept
 *     naming sub-axis.** 0 of 86 wire department names padded
 *     across 33 unique departments — but **all 33 follow a
 *     `<numeric_code> - <name>` convention with hyphen
 *     separator** (`'120 - Product Operations'`, `'130 -
 *     Customer Support'`, `'140 - Customer Success'`, `'150 -
 *     Professional Services'`, `'211 - Product Engineering'`,
 *     `'214 - AI Engineering'`, `'410 - Marketing'`, `'515 -
 *     Enterprise Sales'`, `'620 - Legal'`, `'635 - Talent
 *     Acquisition'`, `'640 - IT'`, plus 22 others). **Distinct
 *     from Constant Contact's numeric-prefix-with-space-only-
 *     separator** (`'100 Engineering'`). **First cohort
 *     observation of the hyphen-separator variant**. Standard
 *     pass-through preserves the bytes byte-for-byte. **Sixty-
 *     fifth cohort plugin** with fully-clean department pass-
 *     through.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/dialpad/jobs';

@SourcePlugin({
  site: Site.DIALPAD,
  name: 'Dialpad',
  category: 'company',
})
@Injectable()
export class DialpadService implements IScraper {
  private readonly logger = new Logger(DialpadService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Dialpad: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10 omitted: emit wire title byte-for-byte (no trim).
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
        const id = `dialpad-${jobId}`;

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
            site: Site.DIALPAD,
            title,
            // D-09 omitted: case-symmetric bare-brand wire.
            companyName: listing.company_name ?? 'Dialpad',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/dialpad/jobs/${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            // D-11 omitted: 0/86 wire departments padded
            // (numeric-prefix-with-hyphen names preserved
            // byte-for-byte).
            department: listing.departments?.[0]?.name ?? null,
          }),
        );
      }

      this.logger.log(`Dialpad: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Dialpad scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
