import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Ackermann Group, LLC — operator of the **dominant Midwest
 * U.S. private-sector mixed-use real-estate development and
 * multi-family / commercial property-management platform**
 * providing in-house leasing, on-site maintenance, asset-
 * management, and investor reporting across a portfolio of
 * Class-A apartment communities and ground-up multi-family /
 * commercial developments (founded by Marvin Ackermann in
 * Cincinnati, Ohio, in 1938 as a single-asset real-estate
 * developer; privately held; family-operated through three
 * generations; serves long-term-hold multi-family investors,
 * commercial-asset partners, and on-site residents at owned-
 * and-managed Class-A apartment communities across the Greater
 * Cincinnati / Columbus / Dayton metropolitan footprint;
 * ships in-house leasing, on-site maintenance, centralized
 * leasing-support, asset-management, and investor-reporting
 * services across the Ohio multi-family / commercial real-
 * estate-services segment — alongside competitors The Connor
 * Group, Drucker + Falk, NorthPoint Realty, Towne Properties,
 * and Crawford Hoying — with an office-resident workforce
 * concentrated across Cincinnati, OH (HQ), Columbus, OH,
 * Dublin, OH, Westerville, OH, Canal Winchester, OH, and
 * Miamisburg, OH) — publishes its consolidated careers board
 * through Greenhouse at the bare slug `ackermanngroup` (wire
 * `company_name === 'Ackermann Group'` — see Spec 177 § 10
 * D-09).
 *
 * **Two structural deviations from the Shopmonkey template** —
 *
 *   - **D-09 sub-axis:** case-symmetric bare-brand
 *     (`'Shopmonkey'` 10 bytes — 1 token) → **two-token
 *     PascalCase + space-strip** (`'Ackermann Group'` 15
 *     bytes — 2 tokens, both PascalCase with caps at byte
 *     index 0 of each token, single internal ASCII space
 *     stripped to yield 14-byte slug `ackermanngroup`).
 *
 *   - **D-11 sub-axis:** clean pass-through-with-depts (0 of
 *     6 unique populated Shopmonkey depts padded) →
 *     **completely-absent departments form** (0 of 12
 *     Ackermann listings carry a department; wire
 *     `departments[]` array is empty for every listing).
 *     **First cohort observation of the completely-absent
 *     departments sub-axis.**
 *
 *   1. **D-04 — wire-shape variant 10 (legacy hosted-board apex).**
 *     `https://boards.greenhouse.io/ackermanngroup/jobs/<id>?gh_jid=<id>`.
 *     **Ninth** plugin in the cohort to use variant 10 (after
 *     Chime, Faire, Flexport, Braze, Descript, Justworks,
 *     Founders, Shopmonkey).
 *
 *   2. **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     **One-hundred-and-thirty-third** plugin to apply D-08.
 *
 *   3. **D-09 — brand-name omitted at runtime; wire form
 *     pass-through.** Wire `company_name === 'Ackermann Group'`
 *     byte-for-byte (15 bytes). First wire token `Ackermann`
 *     9 bytes carries PascalCase cap at index 0; second wire
 *     token `Group` 5 bytes carries PascalCase cap at index 0;
 *     single internal ASCII space stripped to yield the
 *     lowercase 14-byte slug `ackermanngroup`.
 *
 *   4. **D-10 — wire-title trim OMITTED.** 0 of 12 wire titles
 *      in the run-387 probe carry whitespace padding. The
 *      plugin emits `listing.title` byte-for-byte without a
 *      `.trim()`. **Forty-first cohort plugin to omit D-10**.
 *
 *   5. **D-11 — completely-absent departments form.** 0 of 12
 *      listings carry a department; the wire `departments[]`
 *      array is empty for every listing in the run-387 probe.
 *      The `.departments?.[0]?.name ?? null` chain returns
 *      `null` uniformly across the wire — every emitted
 *      JobPostDto carries `department === null`. **First
 *      cohort observation of the completely-absent
 *      departments sub-axis.**
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/ackermanngroup/jobs';

@SourcePlugin({
  site: Site.ACKERMANNGROUP,
  name: 'Ackermann Group',
  category: 'company',
})
@Injectable()
export class AckermannGroupService implements IScraper {
  private readonly logger = new Logger(AckermannGroupService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`AckermannGroup: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10 omitted: 0/12 wire titles padded — emit byte-
        // for-byte without `.trim()`.
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
        const id = `ackermanngroup-${jobId}`;

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
            site: Site.ACKERMANNGROUP,
            title,
            // D-09 pass-through: wire `'Ackermann Group'` (two-
            // token PascalCase + space-strip co-form).
            companyName: listing.company_name ?? 'Ackermann Group',
            // D-04: wire `absolute_url` flows through (variant
            // 10 — legacy hosted-board apex
            // `boards.greenhouse.io/ackermanngroup/jobs/<id>?gh_jid=<id>`).
            // Fallback uses canonical Greenhouse variant-2 form.
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/ackermanngroup/jobs/${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            // D-11 completely-absent departments: 0/12
            // listings carry a department in the run-387 probe;
            // the chain returns `null` uniformly.
            department: listing.departments?.[0]?.name ?? null,
          }),
        );
      }

      this.logger.log(`AckermannGroup: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`AckermannGroup scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
