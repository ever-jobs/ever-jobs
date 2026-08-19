import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Sezzle, Inc. (Sezzle.com) — operator of the **Buy-Now-Pay-
 * Later (BNPL) short-term-instalment payments platform
 * pioneered around the four-instalment-over-six-weeks
 * consumer-credit data model** (founded by Charlie Youakim,
 * Paul Paradis, and Killian Brackey in 2016 in Minneapolis,
 * MN; listed publicly on Nasdaq under the ticker `SEZL`
 * after a secondary offering in August 2023; ships Sezzle
 * Pay-in-4 (short-term BNPL), Sezzle Anywhere (cardless
 * wallet), Sezzle Up (credit-builder), and Sezzle Premium
 * (subscription-bundled merchant access) across the BNPL /
 * deferred-payments / consumer-credit segment — alongside
 * competitors Affirm, Klarna, Afterpay, Zip, PayPal Pay-in-
 * 4, Apple Pay Later, and Splitit — with a hybrid
 * distributed workforce concentrated across Minneapolis
 * (HQ), Toronto, Sydney, Bangalore, Bogota, and Remote
 * across the United States, Canada, Australia, and Latin
 * America) — publishes its consolidated careers board
 * through Greenhouse at the bare slug `sezzle` (case-
 * symmetric with the wire `company_name === 'Sezzle'`; see
 * Spec 169 § 10 D-05).
 *
 * **One D-11 sub-axis deviation from the Instabase (Spec
 * 158) template** — Instabase observes a trailing-pad-only
 * D-11 form, whereas Sezzle observes a **mixed form** (3
 * both-end + 1 leading-only + 1 trailing-only of 11 unique
 * departments) with three NEW first-cohort sub-observations
 * (D-11 both-end pad, D-11 leading-only pad, multi-character
 * 2-char leading whitespace pad). The wire-implementation
 * is byte-for-byte identical because `.trim()` is symmetric
 * over both ends and over multi-character whitespace runs.
 * **Forty-eighth near-clean re-spin** in run-history.
 *
 *   1. **D-04 — wire-shape variant 2 (canonical Greenhouse host).**
 *     `https://job-boards.greenhouse.io/sezzle/jobs/<id>`.
 *
 *   2. **D-08 — entity-decode-then-tag-strip description pipeline.**
 *
 *   3. **D-09 — brand-name trim omitted (case-symmetric).** Wire
 *     `company_name === 'Sezzle'` byte-for-byte (6 bytes —
 *     fully clean, case-symmetric with the lowercase 6-byte
 *     slug `sezzle`).
 *
 *   4. **D-10 — wire-title `.trim()` APPLIED (mixed-pad form,
 *      tenth cohort leading-pad observation).** 38 of 181
 *      wire titles in the run-379 probe carry whitespace
 *      padding — 6 leading-only + 32 trailing-only. The
 *      plugin applies `.trim()` to the wire `title` byte-
 *      for-byte before downstream emit.
 *
 *   5. **D-11 — wire-department `.trim()` APPLIED (NEW MIXED
 *      form + three first-cohort sub-observations).** 5 of
 *      11 unique wire department names padded — 3 both-end
 *      pad with 2-character leading whitespace
 *      (`'  CS-Customer Support '`, `'  EX-Executive '`,
 *      `'  PR-Product '`), 1 leading-only pad with 2-character
 *      leading whitespace (`'  PO-People Ops'`), 1 trailing-
 *      only pad (`'STR-Corporate Development '`). The plugin
 *      applies `.trim()` to the wire `departments[0].name`
 *      byte-for-byte before downstream emit. `.trim()` is
 *      symmetric over both ends and over multi-character
 *      whitespace runs.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/sezzle/jobs';

@SourcePlugin({
  site: Site.SEZZLE,
  name: 'Sezzle',
  category: 'company',
})
@Injectable()
export class SezzleService implements IScraper {
  private readonly logger = new Logger(SezzleService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Sezzle: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10 applied (mixed-pad form): 38/181 wire titles
        // padded — 6 leading-only + 32 trailing-only samples.
        const title = (listing.title ?? '').trim();
        if (!title) continue;

        // D-11 applied (NEW mixed form + 3 first-cohort sub-axes):
        // .trim() handles 2-char leading whitespace, both-end pad,
        // and trailing-only pad symmetrically.
        const dept = (listing.departments?.[0]?.name ?? '').trim() || null;

        if (input.searchTerm) {
          const term = input.searchTerm.toLowerCase();
          const titleMatch = title.toLowerCase().includes(term);
          const deptMatch = (dept ?? '').toLowerCase().includes(term);
          if (!titleMatch && !deptMatch) continue;
        }

        const jobId = listing.id ?? '';
        const id = `sezzle-${jobId}`;

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
            site: Site.SEZZLE,
            title,
            // D-09 omitted: case-symmetric bare-brand wire.
            companyName: listing.company_name ?? 'Sezzle',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/sezzle/jobs/${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            // D-11 applied (mixed form): trim covers all sub-axes.
            department: dept,
          }),
        );
      }

      this.logger.log(`Sezzle: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Sezzle scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
