import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Cerebral, Inc. — operator of the **dominant US-domestic
 * telehealth-mental-health platform pioneered around the
 * subscription-based virtual psychiatric / behavioural-health
 * data model** (founded by Kyle Robertson and Ho Anh in 2019 in
 * San Francisco; raised ~$462M across rounds at peak ~$4.8B
 * valuation in December 2021 led by SoftBank Vision Fund 2;
 * voluntarily exited the controlled-substance prescribing
 * segment in 2022 amid DEA scrutiny and pivoted to a non-
 * controlled-substance behavioural-health stack; ships a
 * subscription-first telepsychiatry / therapy / care-coordination
 * platform across the US-domestic mental-health segment —
 * alongside competitors Talkspace, BetterHelp, Lyra, Spring
 * Health, and Headspace Health — with a hybrid distributed
 * workforce concentrated across San Francisco (HQ), New York,
 * and Remote across the United States) — publishes its
 * consolidated careers board through Greenhouse at the bare
 * slug `cerebral` (the lowercase brand name; case-symmetric
 * with the wire `company_name === 'Cerebral'` — see Spec 094
 * § 10 D-05).
 *
 * **Zero structural deviations from the Adyen (Spec 090)
 * template** — making this the **tenth** Greenhouse-only
 * company-direct plugin in run-history to ship as a clean re-
 * spin of a prior cohort plugin with no per-axis deviations.
 * All five primary axes share with Adyen:
 *
 *   - **D-04 — wire-shape variant 2 (canonical Greenhouse
 *     host).** `https://job-boards.greenhouse.io/cerebral/jobs/<id>`.
 *     **Twenty-fourth** plugin in the cohort to use variant 2.
 *
 *   - **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     **Fiftieth** plugin to apply D-08.
 *
 *   - **D-09 — brand-name trim omitted (case-symmetric).** Wire
 *     `company_name === 'Cerebral'` byte-for-byte (8 bytes —
 *     fully clean; 0 of 6 padded). Case-symmetric with the
 *     lowercase 8-byte slug `cerebral`. **Forty-third cohort
 *     plugin to omit D-09**.
 *
 *   - **D-10 — wire-title `.trim()` applied (trailing-pad form).**
 *     1 of 6 wire titles in the run-304 probe carries trailing
 *     ASCII-space padding (`'Therapy Associate - Connecticut '`
 *     — ~16.7 % pad rate on a small page). Standard
 *     `String.prototype.trim()`. **Twenty-first cohort plugin
 *     to apply D-10**.
 *
 *   - **D-11 — fully-clean department pass-through.** 0 of 6
 *     wire department names padded (`'Client Support'`,
 *     `'Medical Care'`, `'Behavioral Care'` — clean multi-token
 *     forms). **Thirty-eighth cohort plugin** with fully-clean
 *     department pass-through.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/cerebral/jobs';

@SourcePlugin({
  site: Site.CEREBRAL,
  name: 'Cerebral',
  category: 'company',
})
@Injectable()
export class CerebralService implements IScraper {
  private readonly logger = new Logger(CerebralService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Cerebral: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10 applied (trailing-pad form): 1 of 6 wire titles
        // padded — `'Therapy Associate - Connecticut '`.
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
        const id = `cerebral-${jobId}`;

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
            site: Site.CEREBRAL,
            title,
            // D-09 omitted: case-symmetric bare-brand wire.
            companyName: listing.company_name ?? 'Cerebral',
            // D-04: wire `absolute_url` flows through (variant 2
            // — canonical Greenhouse host); fallback uses the
            // same canonical variant-2 form.
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/cerebral/jobs/${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            // D-11 omitted: 0/6 wire departments padded.
            department: listing.departments?.[0]?.name ?? null,
          }),
        );
      }

      this.logger.log(`Cerebral: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Cerebral scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
