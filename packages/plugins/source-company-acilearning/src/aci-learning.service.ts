import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * ACI Learning, LLC — operator of the **dominant U.S.
 * private-sector IT certification training and audit-
 * readiness education platform** providing instructor-led +
 * self-paced IT, audit, and cybersecurity training
 * courseware (founded as ITProTV in 2013 in Gainesville,
 * Florida; rebranded as ACI Learning in 2021 after the Audit
 * Career Institute / Misti merger; privately held; serves
 * enterprise IT teams, individual learners pursuing CompTIA /
 * Cisco / Microsoft / ISACA certifications, plus career-
 * changer cohorts at the in-person Tech Academy campuses;
 * ships ACI Learning Hubs (subscription on-demand IT training
 * catalogue), ACI Learning Tech Academy (in-person 28-week IT
 * bootcamp at Dallas / San Antonio / Salt Lake City / Denver
 * campuses), ACI Learning Audit (audit-readiness training
 * under the legacy Misti / Audit Career Institute brand),
 * and ACI Learning IT-Pro (legacy ITProTV catalogue) across
 * the global IT-training segment — alongside competitors
 * CompTIA, Pluralsight, Coursera, Udemy, LinkedIn Learning,
 * O'Reilly, Skillsoft, and Cybrary — with a hybrid
 * distributed workforce concentrated across Gainesville, FL
 * (HQ), Dallas, TX (Tech Academy campus), San Antonio, TX
 * (Tech Academy campus), Salt Lake City, UT (Tech Academy
 * campus), Denver, CO (Tech Academy campus), and Remote
 * across the United States) — publishes its consolidated
 * careers board through Greenhouse at the bare slug
 * `acilearning` (wire `company_name === 'ACI Learning'` —
 * see Spec 176 § 10 D-09).
 *
 * **One structural deviation from the Collective Health
 * template** —
 *
 *   - **D-09 sub-axis:** case-symmetric two-token space-strip
 *     (`'Collective Health'`) → **acronym-prefix + PascalCase-
 *     suffix + space-strip** (`'ACI Learning'`). **First
 *     cohort observation of acronym-prefix + PascalCase-
 *     suffix + space-strip D-09 sub-pattern co-occurring in
 *     the same wire `company_name`.**
 *
 *   1. **D-04 — wire-shape variant 2 (canonical Greenhouse host).**
 *     `https://job-boards.greenhouse.io/acilearning/jobs/<id>`.
 *     **Seventy-sixth** plugin in the cohort to use variant 2.
 *
 *   2. **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     **One-hundred-and-thirty-second** plugin to apply D-08.
 *
 *   3. **D-09 — brand-name omitted at runtime; wire form
 *     pass-through.** Wire `company_name === 'ACI Learning'`
 *     byte-for-byte (12 bytes). First wire token `ACI` 3
 *     bytes carries all-caps acronym sub-pattern (caps at
 *     0/1/2 vs lowercase 3-byte slug-prefix `aci`); second
 *     wire token `Learning` 8 bytes carries PascalCase sub-
 *     pattern (caps at 0 vs lowercase 8-byte slug-suffix
 *     `learning`); single internal ASCII space stripped to
 *     yield the lowercase 11-byte slug `acilearning`. **First
 *     cohort plugin with an all-caps acronym prefix as the
 *     leading token of a space-strip multi-token wire form.**
 *
 *   4. **D-10 — wire-title `.trim()` retained defensively (no-op form).**
 *     0 of 5 wire titles in the run-386 probe carry padding;
 *     `.trim()` is a safe no-op. **Fortieth cohort plugin to
 *     omit D-10**.
 *
 *   5. **D-11 — wire-department `.trim()` omitted (no-op form).**
 *     0 of 4 unique wire department names padded in the
 *     run-386 probe. **One-hundred-and-fifth cohort plugin**
 *     with fully-clean department pass-through.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/acilearning/jobs';

@SourcePlugin({
  site: Site.ACILEARNING,
  name: 'ACI Learning',
  category: 'company',
})
@Injectable()
export class AciLearningService implements IScraper {
  private readonly logger = new Logger(AciLearningService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`AciLearning: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10 omitted at the wire (0 of 5 padded); defensive
        // `.trim()` retained for symmetry with cohort baseline.
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
        const id = `acilearning-${jobId}`;

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
            site: Site.ACILEARNING,
            title,
            // D-09 pass-through: wire `'ACI Learning'`
            // (acronym-prefix + PascalCase-suffix + space-
            // strip co-form).
            companyName: listing.company_name ?? 'ACI Learning',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/acilearning/jobs/${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            // D-11 omitted at the wire (0 of 4 padded);
            // department pass-through.
            department: listing.departments?.[0]?.name ?? null,
          }),
        );
      }

      this.logger.log(`AciLearning: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`AciLearning scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
