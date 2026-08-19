import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Modern Health, Inc. — operator of the **dominant employer-
 * sponsored mental-health benefits platform pioneered around
 * the precision-mental-healthcare-as-a-service data model**
 * (founded by Alyson Watson and Erica Johnson in 2017 in San
 * Francisco; raised ~$172M across rounds at peak ~$1.17B
 * valuation in February 2021 led by Founders Fund and 01
 * Advisors; ships Modern Health Care Platform (1:1 therapy +
 * coaching + group sessions + self-serve content), Modern
 * Health Care Coordination, Modern Health for SMB, Modern
 * Health Mid-Market, Modern Health Enterprise, and Modern
 * Health Provider Network across the employer-sponsored
 * mental-health / employee-assistance-program (EAP) / digital-
 * mental-healthcare segment — alongside competitors Lyra
 * Health, Spring Health, Headspace Health (Ginger +
 * Headspace), Calm Business, and Talkspace — with a hybrid
 * distributed workforce concentrated across San Francisco
 * (HQ), London, Singapore, and Remote across the United
 * States, the United Kingdom, the European Union, and the
 * Asia-Pacific region) — publishes its consolidated careers
 * board through Greenhouse at the bare slug `modernhealth`
 * (the lowercase 12-byte concatenated slug; case-AND-length-
 * asymmetric vs the wire `company_name === 'Modern Health'` —
 * 13-byte two-token brand with internal ASCII space at byte
 * index 6).
 *
 * **Zero structural deviations from the Constant Contact
 * (Spec 111) template** — making this the **thirty-first**
 * Greenhouse-only company-direct plugin in run-history to
 * ship as a clean re-spin and the **eighth internal-whitespace
 * asymmetry case** in the cohort. All five primary axes share
 * with Constant Contact:
 *
 *   - **D-04 — wire-shape variant 2 (canonical Greenhouse host).**
 *     `https://job-boards.greenhouse.io/modernhealth/jobs/<id>`.
 *     **Forty-eighth** plugin in the cohort to use variant 2.
 *
 *   - **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     **Eighty-seventh** plugin to apply D-08.
 *
 *   - **D-09 — brand-name trim omitted with internal-whitespace
 *     asymmetric wire form.** Wire `company_name === 'Modern
 *     Health'` byte-for-byte (13 bytes — two-token brand with
 *     internal ASCII space at byte index 6; case-AND-length-
 *     asymmetric vs the lowercase 12-byte concatenated slug
 *     `modernhealth`). **Seventy-eighth cohort plugin to omit
 *     D-09**. **Eighth internal-whitespace asymmetry case**
 *     in the cohort (after Scale AI / Maven Clinic / Stitch
 *     Fix / New Relic / Dollar Shave Club / Misfits Market /
 *     Constant Contact).
 *
 *   - **D-10 — wire-title `.trim()` applied (trailing-pad form).**
 *     1 of 14 wire titles in the run-341 probe carries
 *     trailing ASCII-space padding (~7.1 % pad rate;
 *     `'Client Manager (Singapore) '`). **Fifty-first cohort
 *     plugin to apply D-10**.
 *
 *   - **D-11 — fully-clean department pass-through.** 0 of 14
 *     wire department names padded across 8 unique departments
 *     (`'Customer Success'`, `'Engineering'`, `'Legal'`,
 *     `'Marketing'`, `'Operations'`, `'Partnerships'`,
 *     `'People'`, `'Sales'` — clean multi-token forms with
 *     internal whitespace). **Sixty-ninth cohort plugin** with
 *     fully-clean department pass-through.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/modernhealth/jobs';

@SourcePlugin({
  site: Site.MODERNHEALTH,
  name: 'Modern Health',
  category: 'company',
})
@Injectable()
export class ModernHealthService implements IScraper {
  private readonly logger = new Logger(ModernHealthService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Modern Health: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10 applied (trailing-pad form): 1/14 wire titles
        // padded (~7.1 %).
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
        const id = `modernhealth-${jobId}`;

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
            site: Site.MODERNHEALTH,
            title,
            // D-09 omitted: internal-whitespace asymmetric
            // wire form 'Modern Health'.
            companyName: listing.company_name ?? 'Modern Health',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/modernhealth/jobs/${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            // D-11 omitted: 0/14 wire departments padded.
            department: listing.departments?.[0]?.name ?? null,
          }),
        );
      }

      this.logger.log(`Modern Health: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Modern Health scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
