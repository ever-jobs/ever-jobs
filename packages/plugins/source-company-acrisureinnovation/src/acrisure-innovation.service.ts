import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Acrisure Innovation — the **technology / venture-platform
 * innovation unit of Acrisure LLC** (Grand Rapids–headquartered
 * global insurance-brokerage, asset-management, real-estate
 * services, and cyber-services platform; founded 2005;
 * ~$4.3B annual revenue at FY2024; ~17,000 employees globally;
 * backed by Blackstone, BDT Capital, Guggenheim Investments,
 * and Fidelity National Financial), focused on **shipping AI-
 * and data-driven products** for the Acrisure global broker-
 * network — including data-intelligence, forward-deployed
 * delivery, and customer-success engineering teams
 * concentrated across Atlanta, GA; Austin, TX; Boston, MA;
 * and remote U.S. geographies — publishes its standalone
 * careers board through Greenhouse at the bare slug
 * `acrisureinnovation` (wire `company_name === 'Acrisure
 * Innovation'` — see Spec 183 § 10 D-09).
 *
 * **One structural deviation from the AccuWeather (Spec 175)
 * template** —
 *
 *   - **D-11 sub-axis:** AccuWeather applied D-11 (`.trim()`
 *     on department name, 2/15 unique departments padded) →
 *     **omitted** (clean pass-through, 0/4 unique departments
 *     padded).
 *
 *   The **D-10 sub-axis** further differs in **pad-position
 *   sub-form**: AccuWeather's was trailing-only; Acrisure
 *   Innovation's is the new **leading-and-trailing-mixed**
 *   sub-form (1 leading-only-pad listing + 1 leading-AND-
 *   trailing-pad listing on the same fixture). **First
 *   cohort observation of the leading-AND-trailing-pad sub-
 *   form on a single listing.**
 *
 *   1. **D-04 — wire-shape variant 2 (canonical Greenhouse host).**
 *     `https://job-boards.greenhouse.io/acrisureinnovation/jobs/<id>`.
 *     **Eighty-second** plugin in the cohort to use variant 2.
 *
 *   2. **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     **One-hundred-and-thirty-ninth** plugin to apply D-08.
 *
 *   3. **D-09 — brand-name omitted at runtime; wire form
 *      pass-through.** Wire `company_name === 'Acrisure
 *      Innovation'` byte-for-byte (19 bytes; **case-symmetric
 *      two-token PascalCase + ASCII-space + space-strip**:
 *      first token `Acrisure` 8 bytes PascalCase cap-at-0 +
 *      1 internal ASCII space + second token `Innovation`
 *      10 bytes PascalCase cap-at-0 → 18-byte lowercase slug
 *      `acrisureinnovation`). **130th cohort plugin to omit
 *      D-09.**
 *
 *   4. **D-10 — applied (`.trim()` on title; MIXED leading-
 *      only + leading-and-trailing sub-form).** 2 of 15 wire
 *      titles in the run-393 probe carry ASCII-space padding
 *      (~13.3 %): 1 leading-only-pad observation
 *      (`' Forward Deployed (Echo)- Atlanta, GA'`) + 1
 *      leading-AND-trailing-pad observation
 *      (`' Forward Deployed (Echo) - Austin, TX '`). `.trim()`
 *      uniformly strips both leading and trailing pad bytes.
 *      **84th cohort plugin to apply D-10; first cohort
 *      observation of the leading-AND-trailing-pad sub-form
 *      on a single listing.**
 *
 *   5. **D-11 — omitted (clean pass-through).** 0 of 4 unique
 *      wire department names padded (`'Data'`, `'Engineering'`,
 *      `'Marketing'`, `'Product'`); wire `departments[0].name`
 *      flows through byte-for-byte without `.trim()` overlay.
 *      **110th cohort plugin with fully-clean department
 *      pass-through.**
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/acrisureinnovation/jobs';

@SourcePlugin({
  site: Site.ACRISUREINNOVATION,
  name: 'Acrisure Innovation',
  category: 'company',
})
@Injectable()
export class AcrisureInnovationService implements IScraper {
  private readonly logger = new Logger(AcrisureInnovationService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`AcrisureInnovation: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10 applied (MIXED leading-only + leading-and-
        // trailing-pad sub-form): 2/15 wire titles padded
        // (~13.3 %). `.trim()` uniformly strips both leading
        // and trailing pad bytes.
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
        const id = `acrisureinnovation-${jobId}`;

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
            site: Site.ACRISUREINNOVATION,
            title,
            // D-09 pass-through: wire `'Acrisure Innovation'`
            // (case-symmetric two-token PascalCase + space-
            // strip).
            companyName: listing.company_name ?? 'Acrisure Innovation',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/acrisureinnovation/jobs/${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            // D-11 omitted (clean pass-through): 0/4 unique
            // departments padded; wire flows through byte-for-
            // byte without `.trim()` overlay.
            department: listing.departments?.[0]?.name ?? null,
          }),
        );
      }

      this.logger.log(`AcrisureInnovation: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`AcrisureInnovation scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
