import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Alma — operator of the **dominant US-domestic mental-
 * health provider-network and tele-therapy infrastructure
 * platform** (founded by Harry Ritter in 2018 in New York,
 * NY; private since the 2022 Series D round at ~$800M
 * valuation; ships the Alma provider network for therapists,
 * billing-and-insurance infrastructure, and the Alma Mental
 * Health Lab + Care Hub across the consumer-mental-health /
 * tele-therapy / behavioral-health-tech vertical — alongside
 * competitors Headway, Cerebral, Talkspace, Lyra Health, and
 * Spring Health — with a hybrid distributed workforce
 * concentrated across New York (HQ), San Francisco, and
 * Remote across the United States) — publishes its
 * consolidated careers board through Greenhouse at the bare
 * slug `alma` (case-symmetric with the wire `company_name
 * === 'Alma'`; see Spec 152 § 10 D-09).
 *
 * **Zero structural deviations from the Doximity (Spec 127)
 * template** — making this the **fortieth** Greenhouse-only
 * company-direct plugin in run-history to ship as a clean
 * re-spin. **First plugin in the tenth fresh probe sweep**
 * (launched at run #362 after the ninth-sweep was fully
 * exhausted at run #361 GoFundMe).
 *
 *   - **D-04 — wire-shape variant 2 (canonical Greenhouse host).**
 *     `https://job-boards.greenhouse.io/alma/jobs/<id>`.
 *     **Sixtieth** plugin in the cohort to use variant 2 —
 *     **the cohort crosses the 60-plugin variant-2 threshold
 *     at this run.**
 *
 *   - **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     **One-hundred-and-eighth** plugin to apply D-08.
 *
 *   - **D-09 — brand-name trim omitted (case-symmetric).** Wire
 *     `company_name === 'Alma'` byte-for-byte (4 bytes —
 *     fully clean, case-symmetric with the lowercase 4-byte
 *     slug `alma` after casefold). 0 of 9 padded. **Ninety-
 *     ninth cohort plugin to omit D-09**.
 *
 *   - **D-10 — wire-title `.trim()` applied (trailing-pad form).**
 *     1 of 9 wire titles in the run-362 probe carries
 *     trailing ASCII-space padding (~11.1 % pad rate;
 *     `'Senior Data Scientist '`). **Sixty-seventh cohort
 *     plugin to apply D-10**.
 *
 *   - **D-11 — fully-clean department pass-through.** 0 of 9
 *     wire department names padded across 6 unique
 *     departments (`'Business Intelligence'`, `'Clinical
 *     Operations'`, `'Core Ops'`, `'Customer Experience'`,
 *     `'Data Science'`, `'Engineering'` — clean multi-token
 *     forms with internal whitespace). **Eighty-sixth cohort
 *     plugin** with fully-clean department pass-through.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/alma/jobs';

@SourcePlugin({
  site: Site.ALMA,
  name: 'Alma',
  category: 'company',
})
@Injectable()
export class AlmaService implements IScraper {
  private readonly logger = new Logger(AlmaService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Alma: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10 applied (trailing-pad form): 1/9 wire titles
        // padded (~11.1 %).
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
        const id = `alma-${jobId}`;

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
            site: Site.ALMA,
            title,
            // D-09 omitted: case-symmetric bare-brand wire.
            companyName: listing.company_name ?? 'Alma',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/alma/jobs/${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            // D-11 omitted: 0/9 wire departments padded.
            department: listing.departments?.[0]?.name ?? null,
          }),
        );
      }

      this.logger.log(`Alma: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Alma scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
