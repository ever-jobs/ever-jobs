import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Pendo, Inc. (Pendo.io) — operator of the **dominant product-
 * analytics + in-app guidance platform pioneered around the
 * product-led-growth-as-a-service data model** (founded by
 * Todd Olson, Eric Boduch, Erik Troan, and Rahul Jain in 2013
 * in Raleigh, North Carolina; raised ~$356M across rounds at
 * peak ~$2.6B valuation in October 2021 led by Thoma Bravo
 * and Sapphire Ventures; ships Pendo Product Analytics
 * (Insights), Guides + Onboarding (in-app walkthroughs),
 * Feedback (in-app voting / NPS), Roadmaps, and Mobile /
 * Replay across the product-analytics / in-app-guidance /
 * digital-adoption-platform segment — alongside competitors
 * Amplitude, Mixpanel, Heap, Gainsight PX, WalkMe, Whatfix,
 * and LogRocket — with a hybrid distributed workforce
 * concentrated across Raleigh (HQ), New York, Tel Aviv, San
 * Francisco, London, Tokyo, and Remote across the United
 * States, Israel, the United Kingdom, the European Union,
 * and Japan) — publishes its consolidated careers board
 * through Greenhouse at the bare slug `pendo` (case-symmetric
 * with the wire `company_name === 'Pendo'`; see Spec 118 § 10
 * D-05).
 *
 * **Zero structural deviations from the Coursera (Spec 068)
 * template** — making this the **twenty-second** Greenhouse-
 * only company-direct plugin in run-history to ship as a
 * clean re-spin. All five primary axes share with Coursera:
 *
 *   - **D-04 — wire-shape variant 2 (canonical Greenhouse host).**
 *     `https://job-boards.greenhouse.io/pendo/jobs/<id>`.
 *     **Thirty-eighth** plugin in the cohort to use variant 2.
 *
 *   - **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     **Seventy-fourth** plugin to apply D-08.
 *
 *   - **D-09 — brand-name trim omitted (case-symmetric).** Wire
 *     `company_name === 'Pendo'` byte-for-byte (5 bytes —
 *     fully clean, case-symmetric with the lowercase 5-byte
 *     slug `pendo`). **Sixty-fifth cohort plugin to omit D-09**.
 *
 *   - **D-10 — wire-title `.trim()` omitted.** 0 of 18 wire
 *     titles in the run-328 probe carry trailing pad bytes;
 *     the plugin emits `listing.title` byte-for-byte without a
 *     `.trim()`. **Twenty-second cohort plugin to omit D-10**.
 *
 *   - **D-11 — fully-clean department pass-through.** 0 of 18
 *     wire department names padded across 7 unique departments
 *     (`'Brand Marketing'`, `'Commercial'`, `'Engineering
 *     Operations'`, `'Enterprise'`, `'Field Marketing'`,
 *     `'Finance'`, `'Product Marketing'` — clean multi-token
 *     forms with internal whitespace). **Fifty-ninth cohort
 *     plugin** with fully-clean department pass-through.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/pendo/jobs';

@SourcePlugin({
  site: Site.PENDO,
  name: 'Pendo',
  category: 'company',
})
@Injectable()
export class PendoService implements IScraper {
  private readonly logger = new Logger(PendoService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Pendo: fetching ${url}`);

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
        const id = `pendo-${jobId}`;

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
            site: Site.PENDO,
            title,
            // D-09 omitted: case-symmetric bare-brand wire.
            companyName: listing.company_name ?? 'Pendo',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/pendo/jobs/${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            // D-11 omitted: 0/18 wire departments padded.
            department: listing.departments?.[0]?.name ?? null,
          }),
        );
      }

      this.logger.log(`Pendo: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Pendo scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
