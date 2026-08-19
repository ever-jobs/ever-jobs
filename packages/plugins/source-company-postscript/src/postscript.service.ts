import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Postscript Inc. (Postscript.io) — operator of the
 * **dominant Shopify-native SMS-marketing platform pioneered
 * around the e-commerce-conversational-SMS data model**
 * (founded by Adam Turner, Alex Beller, and Colin Turner in
 * 2018 in Brick Township, New Jersey out of the Y Combinator
 * S19 batch; raised ~$120M Series C in May 2022 led by
 * Greylock at peak ~$735M valuation; ships Postscript
 * Subscriber Acquisition Tools (popups / signup forms /
 * keyword campaigns), Postscript Campaigns + Automations
 * (one-shot blasts and lifecycle flows), Postscript Sales
 * Associates (human-agent live-conversation surface), and
 * Postscript Shop (in-SMS shoppable storefronts) across the
 * Shopify-SMS-marketing / e-commerce-conversational-SMS
 * segment — alongside competitors Attentive, Klaviyo SMS,
 * Yotpo SMSBump, Drip, and Privy SMS — with a hybrid fully-
 * remote workforce concentrated across Brick Township, New
 * Jersey (HQ-of-record) and Remote across the United States)
 * — publishes its consolidated careers board through
 * Greenhouse at the bare slug `postscript` (case-symmetric
 * with the wire `company_name === 'Postscript'`; see Spec 164
 * § 10 D-05).
 *
 * **Zero structural deviations from the Alma (Spec 152)
 * template** — case-symmetric brand wire, variant 2 URL,
 * D-08 entity-decode-then-tag-strip, D-10 trailing-pad
 * applied, D-11 omitted. **Forty-sixth clean re-spin** in
 * run-history.
 *
 *   1. **D-04 — wire-shape variant 2 (canonical Greenhouse host).**
 *     `https://job-boards.greenhouse.io/postscript/jobs/<id>`.
 *     **Sixty-eighth** plugin in the cohort to use variant 2.
 *
 *   2. **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     **One-hundred-and-twentieth** plugin to apply D-08 —
 *     **the cohort crosses the 120-plugin D-08-application
 *     threshold at this run.**
 *
 *   3. **D-09 — brand-name trim omitted (case-symmetric).** Wire
 *     `company_name === 'Postscript'` byte-for-byte (10 bytes
 *     — fully clean, case-symmetric with the lowercase 10-byte
 *     slug `postscript`). **One-hundred-and-eleventh cohort
 *     plugin to omit D-09**.
 *
 *   4. **D-10 — wire-title `.trim()` APPLIED (trailing-pad
 *     form).** 2 of 9 wire titles in the run-374 probe carry
 *     trailing ASCII-space padding (~22.2 % pad rate, all
 *     trailing-only — `'Senior Customer Success Manager '`,
 *     `'Senior Engineering Manager, AI '`). The plugin
 *     applies `.trim()` to the wire `title` byte-for-byte
 *     before downstream emit. **Seventy-fourth cohort plugin
 *     to apply D-10**.
 *
 *   5. **D-11 — wire-department `.trim()` omitted (clean wire).**
 *     0 of 4 unique wire department names padded
 *     (`'Business Development'`, `'Customer Success'`,
 *     `'Engineering'`, `'Product'`); the plugin applies
 *     `.trim()` defensively as a safe no-op. **Ninety-sixth
 *     cohort plugin** with fully-clean department pass-through.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/postscript/jobs';

@SourcePlugin({
  site: Site.POSTSCRIPT,
  name: 'Postscript',
  category: 'company',
})
@Injectable()
export class PostscriptService implements IScraper {
  private readonly logger = new Logger(PostscriptService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Postscript: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10 applied (trailing-pad form): 2/9 padded.
        const title = (listing.title ?? '').trim();
        if (!title) continue;

        // D-11 omitted at probe time; .trim() is a safe no-op.
        const dept = (listing.departments?.[0]?.name ?? '').trim() || null;

        if (input.searchTerm) {
          const term = input.searchTerm.toLowerCase();
          const titleMatch = title.toLowerCase().includes(term);
          const deptMatch = (dept ?? '').toLowerCase().includes(term);
          if (!titleMatch && !deptMatch) continue;
        }

        const jobId = listing.id ?? '';
        const id = `postscript-${jobId}`;

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
            site: Site.POSTSCRIPT,
            title,
            // D-09 omitted: case-symmetric bare-brand wire.
            companyName: listing.company_name ?? 'Postscript',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/postscript/jobs/${listing.id}`,
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

      this.logger.log(`Postscript: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Postscript scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
