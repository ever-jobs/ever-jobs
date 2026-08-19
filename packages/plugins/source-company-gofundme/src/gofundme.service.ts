import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * GoFundMe, Inc. — operator of the **dominant social-
 * fundraising platform pioneered around the personal-cause /
 * community-giving data model** (founded by Brad Damphousse
 * and Andrew Ballester in 2010 in San Diego, CA; private
 * since the 2015 Accel + Technology Crossover Ventures
 * growth round at ~$600M valuation; ships GoFundMe (personal
 * / community / nonprofit fundraising), Classy (enterprise
 * nonprofit-fundraising platform, acquired 2022), and
 * gofundme.org (charitable arm) across the consumer-
 * fundraising / nonprofit-tech / charitable-giving vertical
 * — alongside competitors Givebutter, Donorbox, Fundly, and
 * Mightycause — with a hybrid distributed workforce
 * concentrated across San Diego (HQ), Dublin, San Francisco,
 * and Remote across the United States, Europe, and APAC) —
 * publishes its consolidated careers board through Greenhouse
 * at the bare slug `gofundme` (case-asymmetric with the wire
 * `company_name === 'GoFundMe'` PascalCase concat — same
 * byte-count (8 bytes) but byte-distinct via case at THREE
 * indices: 0 (`G` vs `g`), 2 (`F` vs `f`), and 6 (`M` vs
 * `m`); caps at 0/2/6 mark the THREE segment boundaries of
 * `Go | Fund | Me`. See Spec 151 § 10 D-09).
 *
 * **One structural deviation from the AssemblyAI (Spec 108)
 * template** — D-09 sub-axis (consecutive-at-tail acronym
 * caps `AI` → first-cohort non-consecutive segment-boundary
 * caps `Go | Fund | Me`).
 *
 *   - **D-04 — wire-shape variant 2 (canonical Greenhouse host).**
 *     `https://job-boards.greenhouse.io/gofundme/jobs/<id>`.
 *     **Fifty-ninth** plugin in the cohort to use variant 2.
 *
 *   - **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     **One-hundred-and-seventh** plugin to apply D-08.
 *
 *   - **D-09 — brand-name trim omitted with FIRST-COHORT
 *     NON-consecutive segment-boundary THREE-cap PascalCase
 *     case-asymmetric wire form.** Wire `company_name ===
 *     'GoFundMe'` byte-for-byte (8 bytes — fully clean; 0 of
 *     47 padded). Slug `gofundme` is 8 bytes lowercase; case-
 *     asymmetric at THREE byte indices: 0 (`G` vs `g`), 2
 *     (`F` vs `f`), and 6 (`M` vs `m`). Caps at 0/2/6 mark
 *     the **THREE segment boundaries** of `Go | Fund | Me`.
 *     **First cohort observation of NON-consecutive segment-
 *     boundary THREE-cap PascalCase D-09 sub-axis** —
 *     distinct from prior THREE-cap forms (AssemblyAI Spec
 *     108 caps 0/8/9 forming consecutive-at-tail acronym
 *     `AI`, BigID Spec 137 caps 0/3/4 forming consecutive-
 *     at-tail acronym `ID`). GoFundMe's caps mark segment
 *     boundaries rather than form a tail acronym. **3rd
 *     THREE-cap PascalCase plugin overall** in the cohort.
 *     **Ninety-eighth cohort plugin to omit D-09**.
 *
 *   - **D-10 — wire-title `.trim()` applied (mixed pad form).**
 *     5 of 47 wire titles in the run-361 probe carry pad
 *     bytes (~10.6 % pad rate) — 3 trailing-pad
 *     (`'Director, Community Fundraising '`, `'Senior
 *     Software Engineer - Data Platform '`, `'Staff Analytics
 *     Engineer '`) + **2 leading-pad** (`' Privacy Program
 *     Manager'`, `' Staff Software Engineer'`). **Fifth
 *     cohort observation of leading-pad sub-axis** after
 *     Chainguard / Oscar / Celonis / Formlabs. GoFundMe
 *     carries 2 leading-pad samples within the same plugin.
 *     `.trim()` is byte-count agnostic and handles all pad
 *     widths and positions transparently. **Sixty-sixth
 *     cohort plugin to apply D-10**.
 *
 *   - **D-11 — wire-dept `.trim()` applied (trailing-pad form).**
 *     1 of 13 unique wire department names padded
 *     (`'Technical Solutions & Partnerships '`); listing-
 *     level pad rate 1 of 47 (~2.1 %). The plugin applies
 *     `.trim()` to the wire `departments[0].name` byte-for-
 *     byte before downstream emit. **Sixteenth cohort plugin
 *     to apply D-11**.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/gofundme/jobs';

@SourcePlugin({
  site: Site.GOFUNDME,
  name: 'GoFundMe',
  category: 'company',
})
@Injectable()
export class GofundmeService implements IScraper {
  private readonly logger = new Logger(GofundmeService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`GoFundMe: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10 applied (mixed pad form): 5/47 wire titles
        // padded (~10.6 %); 2 leading-pads + 3 trailing-pads.
        const title = (listing.title ?? '').trim();
        if (!title) continue;

        // D-11 applied (trailing-pad form): 1/13 unique wire
        // department names padded (`'Technical Solutions &
        // Partnerships '`).
        const department = (listing.departments?.[0]?.name ?? '').trim() || null;

        if (input.searchTerm) {
          const term = input.searchTerm.toLowerCase();
          const titleMatch = title.toLowerCase().includes(term);
          const deptMatch = (department ?? '').toLowerCase().includes(term);
          if (!titleMatch && !deptMatch) continue;
        }

        const jobId = listing.id ?? '';
        const id = `gofundme-${jobId}`;

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
            site: Site.GOFUNDME,
            title,
            // D-09 omitted: non-consecutive segment-boundary
            // THREE-cap PascalCase wire 'GoFundMe' (caps 0/2/6).
            companyName: listing.company_name ?? 'GoFundMe',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/gofundme/jobs/${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            department,
          }),
        );
      }

      this.logger.log(`GoFundMe: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`GoFundMe scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
