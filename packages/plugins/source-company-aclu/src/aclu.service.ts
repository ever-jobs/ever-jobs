import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * American Civil Liberties Union, Inc. — operator of the
 * **dominant U.S. nonprofit civil-liberties advocacy,
 * constitutional-litigation, and grassroots-mobilization
 * platform** providing pro-bono impact litigation, federal /
 * state legislative-advocacy campaigns, state-affiliate
 * coalition organizing, and rapid-response constitutional-
 * rights defense across First-Amendment, voting-rights,
 * reproductive-freedom, criminal-justice-reform, capital-
 * punishment, immigrants'-rights, racial-justice, and LGBTQ+-
 * rights litigation portfolios (founded by Roger Baldwin,
 * Crystal Eastman, Albert DeSilver, Norman Thomas, and Helen
 * Keller in New York City on 1920-01-19 as a successor to the
 * Civil Liberties Bureau; 501(c)(4) tax-exempt advocacy
 * organization paired with the ACLU Foundation 501(c)(3)
 * litigation arm; serves dues-paying members, pro-bono
 * cooperating attorneys, and affiliated state-chapter
 * litigation teams across all 50 U.S. states plus Puerto
 * Rico and Washington, DC; ships nationwide impact-litigation
 * docket, state-affiliate-coordinated legislative-advocacy
 * campaigns, federal-court amicus briefs, public-education /
 * member-mobilization programs, and rapid-response
 * constitutional-defense alerts across the U.S. nonprofit
 * civil-liberties advocacy segment — alongside competitors
 * NAACP Legal Defense Fund, Southern Poverty Law Center,
 * Electronic Frontier Foundation, Center for Constitutional
 * Rights, Lambda Legal, Knight First Amendment Institute,
 * American Bar Association Center for Human Rights, and
 * Brennan Center for Justice — with a hybrid distributed
 * workforce concentrated across New York, NY (HQ / National
 * Office), Washington, DC (Washington Legislative Office),
 * San Francisco, CA, Durham, NC, and Remote across the United
 * States) — publishes its consolidated National Office careers
 * board through Greenhouse at the bare slug `aclu` (wire
 * `company_name === 'ACLU - National Office'` — see Spec 178
 * § 10 D-09).
 *
 * **One structural deviation from the AccuWeather (Spec 175)
 * template** —
 *
 *   - **D-09 sub-axis:** TWO-cap PascalCase + slug-truncation
 *     (`'AccuWeather Careers'` 19 bytes — 2 tokens, caps at
 *     0/4 of the first token, 1 trailing PascalCase token
 *     dropped) → **all-caps acronym + space-hyphen-space
 *     separator + multi-token suffix → first-token-only-
 *     lowercase slug-truncation** (`'ACLU - National Office'`
 *     22 bytes — 4 wire-tokens split by ASCII spaces: `ACLU`
 *     4-byte all-caps with caps at every byte 0/1/2/3, `-`
 *     1-byte ASCII hyphen separator, `National` 8-byte
 *     PascalCase cap-at-0, `Office` 6-byte PascalCase cap-at-0;
 *     3 wire-tokens dropped including the ASCII-hyphen
 *     separator; yielding the 4-byte lowercase slug `aclu`).
 *     **First cohort observation of (a) an ASCII-hyphen wire-
 *     token being dropped in a slug-truncation D-09 sub-form
 *     AND (b) an all-caps acronym as the first wire-token of
 *     a slug-truncation D-09 sub-form.**
 *
 *   1. **D-04 — wire-shape variant 2 (canonical Greenhouse host).**
 *     `https://job-boards.greenhouse.io/aclu/jobs/<id>`.
 *     **Seventy-seventh** plugin in the cohort to use variant 2.
 *
 *   2. **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     **One-hundred-and-thirty-fourth** plugin to apply D-08.
 *
 *   3. **D-09 — brand-name omitted at runtime; wire form
 *     pass-through.** Wire `company_name === 'ACLU - National
 *     Office'` byte-for-byte (22 bytes). First wire-token
 *     `ACLU` 4 bytes carries all-caps case-asymmetry at every
 *     byte index 0/1/2/3 vs lowercase 4-byte slug `aclu`; wire
 *     drops 3 trailing tokens (`-`, `National`, `Office`),
 *     including the ASCII-hyphen separator. **125th cohort
 *     plugin to omit D-09.** **First cohort observation of (a)
 *     an ASCII-hyphen wire-token being dropped in a slug-
 *     truncation D-09 sub-form AND (b) an all-caps acronym as
 *     the first wire-token of a slug-truncation D-09 sub-
 *     form.**
 *
 *   4. **D-10 — wire-title `.trim()` applied (trailing-pad form).**
 *     2 of 40 wire titles in the run-388 probe carry trailing
 *     ASCII-space padding (~5.0 % pad rate). **Eighty-first
 *     cohort plugin to apply D-10**.
 *
 *   5. **D-11 — wire-department `.trim()` applied (trailing-
 *     pad form).** 1 of 14 unique wire department names padded
 *     (`'National Political & Advocacy '`, 30 bytes, on 3 of
 *     40 listings). **Twenty-second cohort plugin to apply
 *     D-11**.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/aclu/jobs';

@SourcePlugin({
  site: Site.ACLU,
  name: 'ACLU',
  category: 'company',
})
@Injectable()
export class AcluService implements IScraper {
  private readonly logger = new Logger(AcluService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`ACLU: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10 applied (trailing-pad form): 2/40 wire titles
        // padded (~5.0 %) — e.g., `'DevOps Engineering
        // Manager '`, `'Technical Project Manager (Term-
        // Limited) '`.
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
        const id = `aclu-${jobId}`;

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
            site: Site.ACLU,
            title,
            // D-09 pass-through: wire `'ACLU - National Office'`
            // (all-caps acronym + space-hyphen-space separator
            // + slug-truncation co-form).
            companyName: listing.company_name ?? 'ACLU - National Office',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/aclu/jobs/${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            // D-11 applied (trailing-pad form): 1/14 unique
            // departments padded — `'National Political &
            // Advocacy '`.
            department: listing.departments?.[0]?.name
              ? listing.departments[0].name.trim()
              : null,
          }),
        );
      }

      this.logger.log(`ACLU: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`ACLU scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
