import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Bandwidth, Inc. — operator of the **dominant US-domestic
 * software-defined CPaaS platform pioneered around the
 * carrier-grade voice + messaging API + 911-emergency-services
 * data model** (founded by Henry Kaestner, David Morken, and
 * Mark McCullough in 1999 in Raleigh, NC; Nasdaq-listed (BAND)
 * since November 2017 IPO at a $475M initial valuation; ships
 * voice, messaging, emergency services, and the Maestro CPaaS
 * stack across the cloud-communications segment — alongside
 * competitors Twilio, Vonage, Plivo, Sinch, Telnyx, and
 * MessageBird — with a hybrid distributed workforce
 * concentrated across Raleigh NC (HQ), Denver, Bangalore, and
 * Remote across the United States) — publishes its consolidated
 * careers board through Greenhouse at the bare slug `bandwidth`
 * (the lowercase brand-name; case-symmetric with the wire
 * `company_name === 'Bandwidth'` — see Spec 109 § 10 D-05).
 *
 * **Zero structural deviations from the Airtable (Spec 106)
 * template** — making this the **fifteenth** Greenhouse-only
 * company-direct plugin in run-history to ship as a clean re-
 * spin (after Coursera off Chime, Flexport off Faire, Glossier
 * off Flexport, Marqeta off Calendly, New Relic off Maven
 * Clinic, Scopely off Marqeta, Adyen off Marqeta, Bobbie off
 * Coursera, Cerebral off Adyen, Misfits Market off New Relic,
 * Monzo off Adyen, PlanetScale off Coursera, Airtable off
 * Cerebral, plus a corrected count). All five primary axes
 * share with Airtable:
 *
 *   - **D-04 — wire-shape variant 2 (canonical Greenhouse
 *     host).** `https://job-boards.greenhouse.io/bandwidth/jobs/<id>`.
 *     **Thirty-fourth** plugin in the cohort to use variant 2.
 *
 *   - **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     **Sixty-fifth** plugin to apply D-08.
 *
 *   - **D-09 — brand-name trim omitted (case-symmetric).** Wire
 *     `company_name === 'Bandwidth'` byte-for-byte (9 bytes —
 *     fully clean; 0 of 45 padded). Case-symmetric with the
 *     lowercase 9-byte slug `bandwidth`. **Fifty-sixth cohort
 *     plugin to omit D-09**.
 *
 *   - **D-10 — wire-title `.trim()` applied (trailing-pad form).**
 *     10 of 45 wire titles in the run-319 probe carry trailing
 *     ASCII-space padding (~22 % pad rate — high-mid range).
 *     **Thirty-third cohort plugin to apply D-10**.
 *
 *   - **D-11 — fully-clean department pass-through.** 0 of 45
 *     wire department names padded across 14 unique departments
 *     (`'IT'`, `'Internship'`, `'Marketing'`, `'Network
 *     Engineering'`, `'Network Operations Center'`, `'Network
 *     Strategy'`, `'Ohana Child Development Center'`,
 *     `'Operations'`, plus 6 others — clean multi-token forms).
 *     **Forty-ninth cohort plugin** with fully-clean department
 *     pass-through.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/bandwidth/jobs';

@SourcePlugin({
  site: Site.BANDWIDTH,
  name: 'Bandwidth',
  category: 'company',
})
@Injectable()
export class BandwidthService implements IScraper {
  private readonly logger = new Logger(BandwidthService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Bandwidth: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10 applied (trailing-pad form): 10/45 wire titles
        // padded (~22 %).
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
        const id = `bandwidth-${jobId}`;

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
            site: Site.BANDWIDTH,
            title,
            // D-09 omitted: case-symmetric bare-brand wire.
            companyName: listing.company_name ?? 'Bandwidth',
            // D-04: wire `absolute_url` flows through (variant 2
            // — canonical Greenhouse host); fallback uses the
            // same canonical variant-2 form.
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/bandwidth/jobs/${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            // D-11 omitted: 0/45 wire departments padded.
            department: listing.departments?.[0]?.name ?? null,
          }),
        );
      }

      this.logger.log(`Bandwidth: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Bandwidth scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
