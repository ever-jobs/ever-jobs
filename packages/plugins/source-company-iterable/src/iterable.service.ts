import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Iterable, Inc. (Iterable.com) — operator of the **dominant
 * cross-channel marketing-automation platform pioneered around
 * the customer-data-and-engagement-hub data model** (founded
 * by Justin Zhu and Andrew Boni in 2013 in San Francisco;
 * raised ~$342M across rounds at peak ~$2B valuation in June
 * 2021 led by Silver Lake Waterman; ships Iterable AI Suite
 * (Brand Affinity / Copy Assist / Predictive Goals / Smart
 * Send Time), Iterable Studio (campaign-orchestration canvas),
 * Iterable Journeys (lifecycle-automation flows), Iterable
 * Embedded Messaging (in-app + inbox surface), and Iterable
 * Data Feeds (real-time customer-data ingest) across the
 * cross-channel-customer-engagement / marketing-automation
 * segment — alongside competitors Braze, Salesforce Marketing
 * Cloud, Klaviyo, MoEngage, OneSignal, Customer.io, and
 * Bloomreach Engagement — with a hybrid distributed workforce
 * concentrated across San Francisco (HQ), New York City,
 * Denver, London, Lisbon, and Remote across the United
 * States, the United Kingdom, and Portugal) — publishes its
 * consolidated careers board through Greenhouse at the bare
 * slug `iterable` (case-symmetric with the wire
 * `company_name === 'Iterable'`; see Spec 159 § 10 D-05).
 *
 * **One structural deviation from the Alma (Spec 152)
 * template** — D-10 sub-axis (Alma 1/9 trailing-only →
 * Iterable 4/40 mixed-pad with **8th cohort leading-pad
 * observation** — 2 trailing + 2 leading-pad after Chainguard
 * / Oscar / Celonis / Formlabs / GoFundMe / BitGo /
 * Instabase).
 *
 *   1. **D-10 — wire-title `.trim()` APPLIED (mixed-pad form,
 *      8th cohort leading-pad observation).** 4 of 40 wire
 *      titles in the run-369 probe carry whitespace padding —
 *      2 trailing (`'Senior Site Reliability Engineer (Cloud
 *      Platform) '`, `'Software Engineer II (Infrastructure)
 *      '`) and 2 leading (`' FP&A Manager'`, `' Solutions
 *      Consultant'`). The plugin applies `.trim()` to the
 *      wire `title` byte-for-byte before downstream emit.
 *      **Seventy-second cohort plugin to apply D-10**.
 *
 * Shared with Alma:
 *
 *   - **D-04 — wire-shape variant 2 (canonical Greenhouse host).**
 *     `https://job-boards.greenhouse.io/iterable/jobs/<id>`.
 *     **Sixty-fourth** plugin in the cohort to use variant 2.
 *
 *   - **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     **One-hundred-and-fifteenth** plugin to apply D-08.
 *
 *   - **D-09 — brand-name trim omitted (case-symmetric).** Wire
 *     `company_name === 'Iterable'` byte-for-byte (8 bytes —
 *     fully clean, case-symmetric with the lowercase 8-byte
 *     slug `iterable`). **One-hundred-and-sixth cohort plugin
 *     to omit D-09**.
 *
 *   - **D-11 — wire-department `.trim()` omitted (clean wire).**
 *     0 of 6 unique wire department names padded
 *     (`'Engineering'`, `'Finance'`, `'Marketing'`, `'Product'`,
 *     `'Sales'`, `'Security & IT'`); the plugin applies
 *     `.trim()` defensively as a safe no-op. **Ninety-first
 *     cohort plugin** with fully-clean department pass-through —
 *     **the cohort crosses the 91-plugin D-11-omission
 *     threshold at this run.**
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/iterable/jobs';

@SourcePlugin({
  site: Site.ITERABLE,
  name: 'Iterable',
  category: 'company',
})
@Injectable()
export class IterableService implements IScraper {
  private readonly logger = new Logger(IterableService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Iterable: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10 applied (mixed-pad form): 4/40 wire titles
        // padded — trailing + leading samples.
        const title = (listing.title ?? '').trim();
        if (!title) continue;

        // D-11 omitted at probe time; .trim() is a safe no-op
        // on clean wire.
        const dept = (listing.departments?.[0]?.name ?? '').trim() || null;

        if (input.searchTerm) {
          const term = input.searchTerm.toLowerCase();
          const titleMatch = title.toLowerCase().includes(term);
          const deptMatch = (dept ?? '').toLowerCase().includes(term);
          if (!titleMatch && !deptMatch) continue;
        }

        const jobId = listing.id ?? '';
        const id = `iterable-${jobId}`;

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
            site: Site.ITERABLE,
            title,
            // D-09 omitted: case-symmetric bare-brand wire.
            companyName: listing.company_name ?? 'Iterable',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/iterable/jobs/${listing.id}`,
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

      this.logger.log(`Iterable: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Iterable scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
