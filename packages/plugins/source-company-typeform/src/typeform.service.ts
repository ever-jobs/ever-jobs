import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Typeform — operator of the dominant conversational form-builder
 * platform pioneered around the one-question-at-a-time form data
 * model (founded by David Okuniev and Robert Muñoz in 2012 in
 * Barcelona; raised $187M+ across rounds led by General Atlantic,
 * Index Ventures, and Connect Ventures at a peak $1.0B valuation;
 * ships a freemium B2C / B2B form-builder + payments + Acuity-
 * like scheduling product across the form-and-survey segment —
 * alongside competitors Google Forms, SurveyMonkey, JotForm,
 * Cognito Forms, and Tally — with a hybrid distributed workforce
 * concentrated across Barcelona, Berlin, San Francisco, and
 * Remote across Europe and the Americas) — publishes its
 * consolidated careers board through Greenhouse at the bare slug
 * `typeform` (the lowercase brand name; case-symmetric with the
 * wire `company_name === 'Typeform'`; see Spec 089 § 10 D-05).
 *
 * **One structural deviation from the Lattice (Spec 074)
 * template** — D-04 wire-shape variant 2 (Typeform variant 2
 * canonical Greenhouse host; Lattice variant 15 bare brand-
 * domain). All other axes share with Lattice: D-08 entity-
 * decode-then-tag-strip, D-09 omitted with case-symmetric bare-
 * brand wire, D-10 omitted, **D-11 applied with trailing-pad
 * form**.
 *
 * **Cohort observation of note:** Typeform is the **third cohort
 * plugin to apply D-11** (after Lattice's run-284 first-ever
 * trailing-pad application and DataCamp's run-291 first-ever
 * leading-pad application). Typeform's D-11 application is
 * trailing-pad, lifting Lattice's first-ever observation from a
 * one-off to a recurring axis.
 *
 *   - **D-04 — wire-shape variant 2 (canonical Greenhouse host).**
 *     **Twenty-first** plugin in the cohort to use variant 2.
 *
 *   - **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     **Forty-fifth** plugin to apply D-08.
 *
 *   - **D-09 — brand-name trim omitted (case-symmetric).** Wire
 *     `company_name === 'Typeform'` byte-for-byte (8 bytes —
 *     fully clean). **Thirty-eighth cohort plugin to omit D-09**.
 *
 *   - **D-10 — wire-title `.trim()` omitted.** 0 of 22 wire titles
 *     in the run-299 probe carry whitespace padding (the wire is
 *     fully clean — `'Account Executive - EU'`, `'Creative Project
 *     Manager'`, etc.). **Sixteenth cohort plugin to omit D-10**.
 *
 *   - **D-11 — wire-department `.trim()` applied (trailing-pad
 *     form).** 3 of 22 wire department names in the run-299
 *     probe carry trailing ASCII-space padding (`'Product '` × 2
 *     plus one other trailing-pad case; ~13.6 % pad rate). The
 *     plugin applies `.trim()` to `listing.departments?.[0]?.name`
 *     before downstream filters and emit. **Third cohort plugin
 *     to apply D-11** (after Lattice's run-284 first-ever
 *     trailing-pad application and DataCamp's run-291 first-ever
 *     leading-pad application). Typeform's trailing-pad form
 *     lifts Lattice's first-ever observation from a one-off to a
 *     recurring axis.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/typeform/jobs';

@SourcePlugin({
  site: Site.TYPEFORM,
  name: 'Typeform',
  category: 'company',
})
@Injectable()
export class TypeformService implements IScraper {
  private readonly logger = new Logger(TypeformService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Typeform: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10 omitted: 0/22 wire titles padded — pass through
        // byte-for-byte.
        const title = listing.title ?? '';
        if (!title) continue;

        // D-11 applied: 3/22 wire departments padded with trailing
        // ASCII space (`'Product '` etc.) — trim on read so the
        // search filter and emitted DTO both see the clean form.
        // Third cohort plugin to apply D-11.
        const department = (listing.departments?.[0]?.name ?? '').trim() || null;

        if (input.searchTerm) {
          const term = input.searchTerm.toLowerCase();
          const titleMatch = title.toLowerCase().includes(term);
          const deptMatch = (department ?? '').toLowerCase().includes(term);
          if (!titleMatch && !deptMatch) continue;
        }

        const jobId = listing.id ?? '';
        const id = `typeform-${jobId}`;

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
            site: Site.TYPEFORM,
            title,
            // D-09 omitted: case-symmetric bare-brand wire.
            companyName: listing.company_name ?? 'Typeform',
            // D-04: wire `absolute_url` flows through (variant 2);
            // fallback uses canonical Greenhouse variant-2 form.
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/typeform/jobs/${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            // D-11 applied: trimmed form.
            department,
          }),
        );
      }

      this.logger.log(`Typeform: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Typeform scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
