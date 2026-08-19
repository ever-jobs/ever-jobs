import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Vonage Holdings Corp. — operator of the **dominant CPaaS /
 * UCaaS / contact-center platforms pioneered around the SIP-
 * trunking / programmable-voice / programmable-messaging /
 * programmable-video data model** (founded by Jeff Pulver and
 * Daniel Borislow in 2001 in Holmdel NJ; public on the NYSE
 * from May 2006 IPO at $16/share until July 2022 acquisition
 * by Ericsson for $6.2B / $21/share; ships Vonage Business
 * Communications (UCaaS), Vonage Communications APIs (Voice /
 * Messages / Video / Verify / Number Insight / In-app
 * Messaging / SIP Trunking — Nexmo platform acquired June
 * 2016 for $230M), Vonage Contact Center (NewVoiceMedia
 * acquired October 2018 for $350M), and Vonage AI Studio
 * across the CPaaS / UCaaS / contact-center segment —
 * alongside competitors Twilio, Bandwidth, RingCentral, 8x8,
 * Cisco Webex, Zoom Phone, and Microsoft Teams Phone — with a
 * hybrid distributed workforce concentrated across Holmdel NJ
 * (HQ), San Francisco, London, Aveiro (Portugal), Wrocław
 * (Poland), Tel Aviv, Bangalore, and Remote across the United
 * States, Portugal, Poland, the United Kingdom, the European
 * Union, Israel, India, and the Asia-Pacific region) —
 * publishes its consolidated careers board through Greenhouse
 * at the bare slug `vonage` (the lowercase 6-byte slug; case-
 * symmetric with the wire `company_name === 'Vonage'`; see
 * Spec 119 § 10 D-05).
 *
 * **Zero structural deviations from the Otter (Spec 116)
 * template** — making this the **twenty-third** Greenhouse-
 * only company-direct plugin in run-history to ship as a
 * clean re-spin. **Run #329 closes out the seventh fresh
 * probe sweep** — Vonage is the 14th and last candidate from
 * the run-316 pool. All five primary axes share with Otter:
 *
 *   - **D-04 — wire-shape variant 2 (canonical Greenhouse host).**
 *     `https://job-boards.greenhouse.io/vonage/jobs/<id>`.
 *     **Thirty-ninth** plugin in the cohort to use variant 2.
 *
 *   - **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     **Seventy-fifth** plugin to apply D-08.
 *
 *   - **D-09 — brand-name trim omitted (case-symmetric).** Wire
 *     `company_name === 'Vonage'` byte-for-byte (6 bytes —
 *     fully clean, case-symmetric with the lowercase 6-byte
 *     slug `vonage`). **Sixty-sixth cohort plugin to omit D-09**.
 *
 *   - **D-10 — wire-title `.trim()` applied (trailing-pad form).**
 *     11 of 81 wire titles in the run-329 probe carry trailing
 *     ASCII-space padding (~13.6 % pad rate). All trailing-
 *     only. **Forty-second cohort plugin to apply D-10**.
 *
 *   - **D-11 — fully-clean department pass-through.** 0 of 81
 *     wire department names padded across 19 unique departments
 *     (`'API BU Engineering'`, `'API BU Product'`, `'API
 *     Customer Care'`, `'API In-BU Operations'`, `'API Sales
 *     Development'`, `'Alliances and Channel Sales'`,
 *     `'Americas MME Sales'`, `'Apps BU Engineering'`, `'Apps
 *     Operations'`, `'BI'`, `'COO - R&D'`, `'Carrier
 *     Management'`, plus 7 others — clean multi-token forms
 *     with internal whitespace, hyphens, ampersands, and
 *     acronym prefixes / suffixes). **Sixtieth cohort plugin**
 *     with fully-clean department pass-through.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/vonage/jobs';

@SourcePlugin({
  site: Site.VONAGE,
  name: 'Vonage',
  category: 'company',
})
@Injectable()
export class VonageService implements IScraper {
  private readonly logger = new Logger(VonageService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Vonage: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10 applied (trailing-pad form): 11/81 wire titles
        // padded (~13.6 %).
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
        const id = `vonage-${jobId}`;

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
            site: Site.VONAGE,
            title,
            // D-09 omitted: case-symmetric bare-brand wire.
            companyName: listing.company_name ?? 'Vonage',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/vonage/jobs/${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            // D-11 omitted: 0/81 wire departments padded.
            department: listing.departments?.[0]?.name ?? null,
          }),
        );
      }

      this.logger.log(`Vonage: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Vonage scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
