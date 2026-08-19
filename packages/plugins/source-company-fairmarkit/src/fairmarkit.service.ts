import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Fairmarkit, Inc. — operator of the **AI-driven autonomous
 * sourcing / tail-spend procurement platform pioneered around
 * the long-tail-spend e-procurement data model** (founded by
 * Kevin Frechette and Tarek Alaruri in 2017 in Boston, MA;
 * private since the 2022 Series C round at ~$700M valuation;
 * ships Fairmarkit KOJO (autonomous sourcing), RFx Studio
 * (RFP / RFQ orchestration), and Tail Spend Engine across
 * the e-procurement / strategic-sourcing / tail-spend-
 * management vertical — alongside competitors Coupa, GEP
 * SMART, Ivalua, and Workday Strategic Sourcing — with a
 * hybrid distributed workforce concentrated across Boston
 * (HQ), London, and Remote across the United States, Europe,
 * and APAC) — publishes its consolidated careers board
 * through Greenhouse at the bare slug `fairmarkit` (case-
 * symmetric with the wire `company_name === 'Fairmarkit'`;
 * see Spec 146 § 10 D-09).
 *
 * **Zero structural deviations from the Melio (Spec 130)
 * template** — making this the **thirty-seventh** Greenhouse-
 * only company-direct plugin in run-history to ship as a
 * clean re-spin. All five primary axes share with Melio,
 * with a notable D-10 sub-axis observation:
 *
 *   - **D-04 — wire-shape variant 2 (canonical Greenhouse host).**
 *     `https://job-boards.greenhouse.io/fairmarkit/jobs/<id>`.
 *     **Fifty-sixth** plugin in the cohort to use variant 2.
 *
 *   - **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     **One-hundred-and-second** plugin to apply D-08.
 *
 *   - **D-09 — brand-name trim omitted (case-symmetric).** Wire
 *     `company_name === 'Fairmarkit'` byte-for-byte (10 bytes
 *     — fully clean, case-symmetric with the lowercase 10-byte
 *     slug `fairmarkit` after casefold). 0 of 12 padded.
 *     **Ninety-third cohort plugin to omit D-09**.
 *
 *   - **D-10 — wire-title `.trim()` applied (trailing-pad form).**
 *     5 of 12 wire titles in the run-356 probe carry trailing
 *     ASCII-space padding (~41.7 % pad rate, all trailing-only
 *     — `'Senior Field Marketing Manager '`, `'Senior Frontend
 *     Engineer '`, `'Senior Software Engineer '`, `'Technical
 *     Architect '`, `'Сore Software Architect '`).
 *     **First cohort observation of leading mojibake-Cyrillic-
 *     Es residue** — the title `'Сore Software Architect '`
 *     carries the byte sequence `c3 90 c2 a1` at the head
 *     (wire-side double-UTF-8-encoded U+0421 Cyrillic Capital
 *     Es `С`, visual homograph of Latin `C`). Distinct from
 *     prior mojibake-NBSP form (Bloomreach Spec 139, ExpressVPN
 *     Spec 145) which targets the trailing position with NBSP.
 *     JavaScript `.trim()` does NOT consider U+00D0 (`Ð`) or
 *     U+00A1 (`¡`) as whitespace, so the leading mojibake pair
 *     is preserved by-design; trim only strips the trailing
 *     ASCII-space pad. Wire-faithful pass-through. **Sixty-
 *     third cohort plugin to apply D-10**.
 *
 *   - **D-11 — wire-dept `.trim()` applied (trailing-pad form).**
 *     2 of 7 unique wire department names padded
 *     (`'Customer Success - Services '`, `'International
 *     Operations '`); listing-level pad rate 2 of 12 (~16.7 %).
 *     The plugin applies `.trim()` to the wire
 *     `departments[0].name` byte-for-byte before downstream
 *     emit. **Fifteenth cohort plugin to apply D-11**.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/fairmarkit/jobs';

@SourcePlugin({
  site: Site.FAIRMARKIT,
  name: 'Fairmarkit',
  category: 'company',
})
@Injectable()
export class FairmarkitService implements IScraper {
  private readonly logger = new Logger(FairmarkitService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Fairmarkit: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10 applied (trailing-pad form): 5/12 wire titles
        // padded (~41.7 %); 1 sample carries leading mojibake-
        // Cyrillic-Es residue (`c3 82 c2 a1`) — `.trim()`
        // strips the trailing space, leading mojibake bytes
        // preserved by-design (not whitespace).
        const title = (listing.title ?? '').trim();
        if (!title) continue;

        // D-11 applied (trailing-pad form): 2/7 unique wire
        // department names padded.
        const department = (listing.departments?.[0]?.name ?? '').trim() || null;

        if (input.searchTerm) {
          const term = input.searchTerm.toLowerCase();
          const titleMatch = title.toLowerCase().includes(term);
          const deptMatch = (department ?? '').toLowerCase().includes(term);
          if (!titleMatch && !deptMatch) continue;
        }

        const jobId = listing.id ?? '';
        const id = `fairmarkit-${jobId}`;

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
            site: Site.FAIRMARKIT,
            title,
            // D-09 omitted: case-symmetric bare-brand wire.
            companyName: listing.company_name ?? 'Fairmarkit',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/fairmarkit/jobs/${listing.id}`,
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

      this.logger.log(`Fairmarkit: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Fairmarkit scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
