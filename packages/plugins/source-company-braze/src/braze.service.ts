import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Braze, Inc. — operator of the **dominant customer-engagement
 * SaaS platform pioneered around the cross-channel messaging +
 * journey-orchestration data model** (founded by Bill Magnuson,
 * Jon Hyman, and Mark Ghermezian in 2011 as Appboy in New York
 * City; rebranded to Braze in 2017; Nasdaq-listed (BRZE) since
 * November 2021 IPO at a $7.8B initial valuation; ships push,
 * email, SMS, in-app, content cards, and the Sage AI
 * intelligence layer across the customer-engagement / customer-
 * data-platform segment — alongside competitors Iterable,
 * MoEngage, OneSignal, Twilio Engage, Klaviyo, Salesforce
 * Marketing Cloud, and Adobe Marketo — with a hybrid distributed
 * workforce concentrated across New York (HQ), Chicago,
 * Austin, San Francisco, London, Berlin, Singapore, Tokyo,
 * Sydney, and Remote across the United States, UK, EU, and
 * APAC) — publishes its consolidated careers board through
 * Greenhouse at the bare slug `braze` (the lowercase brand-
 * name; case-symmetric with the wire `company_name === 'Braze'`
 * — see Spec 110 § 10 D-05).
 *
 * **Zero structural deviations from the Flexport (Spec 070)
 * template** — making this the **seventeenth** Greenhouse-only
 * company-direct plugin in run-history to ship as a clean re-
 * spin (after Coursera, Flexport, Glossier, Marqeta, New Relic,
 * Scopely, Adyen, Bobbie, Cerebral, Misfits Market, Monzo,
 * PlanetScale, Airtable, Bandwidth, plus corrected counts).
 * All five primary axes share with Flexport:
 *
 *   - **D-04 — wire-shape variant 10 (legacy hosted-board apex).**
 *     `https://boards.greenhouse.io/braze/jobs/<id>?gh_jid=<id>`.
 *     **Fourth** plugin in the cohort to use variant 10 (after
 *     Chime, Faire, Flexport).
 *
 *   - **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     **Sixty-sixth** plugin to apply D-08.
 *
 *   - **D-09 — brand-name trim omitted (case-symmetric).** Wire
 *     `company_name === 'Braze'` byte-for-byte (5 bytes — fully
 *     clean; 0 of 207 padded). Case-symmetric with the
 *     lowercase 5-byte slug `braze`. **Fifty-seventh cohort
 *     plugin to omit D-09**.
 *
 *   - **D-10 — wire-title `.trim()` applied (trailing-pad form).**
 *     3 of 207 wire titles in the run-320 probe carry trailing
 *     ASCII-space padding (~1.5 % pad rate — low-end of cohort).
 *     **Thirty-fourth cohort plugin to apply D-10**.
 *
 *   - **D-11 — fully-clean department pass-through.** 0 of 207
 *     wire department names padded across 11 unique departments
 *     (`'Customer Experience'`, `'Engineering'`, `'Finance'`,
 *     `'GTM Operations'`, `'Growth'`, `'Legal'`, `'Marketing'`,
 *     `'Partnerships'`, plus 3 others — clean multi-token
 *     forms). **Fifty-first cohort plugin** with fully-clean
 *     department pass-through.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/braze/jobs';

@SourcePlugin({
  site: Site.BRAZE,
  name: 'Braze',
  category: 'company',
})
@Injectable()
export class BrazeService implements IScraper {
  private readonly logger = new Logger(BrazeService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Braze: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10 applied (trailing-pad form): 3/207 wire titles
        // padded (~1.5 %).
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
        const id = `braze-${jobId}`;

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
            site: Site.BRAZE,
            title,
            // D-09 omitted: case-symmetric bare-brand wire.
            companyName: listing.company_name ?? 'Braze',
            // D-04: wire `absolute_url` flows through (variant 10
            // — legacy hosted-board apex `boards.greenhouse.io`
            // with `?gh_jid=` query); fallback uses canonical
            // Greenhouse variant-2 form.
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/braze/jobs/${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            // D-11 omitted: 0/207 wire departments padded.
            department: listing.departments?.[0]?.name ?? null,
          }),
        );
      }

      this.logger.log(`Braze: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Braze scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
