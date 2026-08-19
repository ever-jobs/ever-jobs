import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Academy with Community Partners (ACP) — operator of an
 * Arizona-based charter-school network serving at-risk and
 * homeless youth through alternative-curriculum high-school
 * and special-education programs (founded in 2004 by
 * educators serving the greater Phoenix metropolitan area;
 * Arizona Online Instruction charter-school network; serves
 * 9th-12th-grade students across multiple greater-Phoenix
 * campuses with a hybrid in-person / distance-learning
 * curriculum centred on small-cohort instruction, special-
 * education accommodations, and alternative-schedule diploma
 * pathways) — publishes its consolidated careers board
 * through Greenhouse at the bare slug `acp` (wire
 * `company_name === 'Academy with Community Partners'` —
 * see Spec 181 § 10 D-09).
 *
 * **Two structural deviations from the ACOG (Spec 179)
 * template** —
 *
 *   - **D-10 sub-axis:** trailing-pad applied (1 of 6 wire
 *     titles padded ~16.7 %) → **omitted (clean pass-
 *     through)** (0 of 3 wire titles padded — defensive
 *     `.trim()` safe no-op).
 *   - **D-09 sub-axis (cardinality variant):** 4 PascalCase
 *     + 2 connectors (`'American College of Obstetricians
 *     and Gynecologists'` 51 bytes → 4-byte slug `acog`) →
 *     **3 PascalCase + 1 connector** (`'Academy with
 *     Community Partners'` 31 bytes — 4 wire-tokens, 3
 *     PascalCase + 1 lowercase-connector; slug `acp` formed
 *     by sampling first letter of each PascalCase wire-token
 *     with connector-skip). **Second cohort observation of
 *     acronym-by-initials slug derivation with connector-
 *     skip** — validates the ACOG sub-pattern at a lower-
 *     cardinality wire-form.
 *
 *   1. **D-04 — wire-shape variant 2 (canonical Greenhouse host).**
 *     `https://job-boards.greenhouse.io/acp/jobs/<id>`.
 *     **Eightieth** plugin in the cohort to use variant 2.
 *
 *   2. **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     **One-hundred-and-thirty-seventh** plugin to apply D-08.
 *
 *   3. **D-09 — brand-name omitted at runtime; wire form
 *      pass-through.** Wire `company_name === 'Academy with
 *      Community Partners'` byte-for-byte (31 bytes). 4
 *      wire-tokens split by ASCII spaces: `Academy` (7-byte
 *      PascalCase, cap at byte 0 only), `with` (4-byte all-
 *      lowercase connector), `Community` (9-byte PascalCase,
 *      cap at byte 0 only), `Partners` (8-byte PascalCase,
 *      cap at byte 0 only). Slug is 3-byte lowercase `acp` —
 *      formed by sampling the first letter of each
 *      PascalCase wire-token in order (A from Academy, C
 *      from Community, P from Partners), skipping the 1
 *      lowercase-connector token (`with`), and lowercasing
 *      the result. **128th cohort plugin to omit D-09.**
 *      **Second cohort observation of acronym-by-initials
 *      slug derivation with connector-skip.**
 *
 *   4. **D-10 — omitted (clean pass-through).** 0 of 3 wire
 *      titles in the run-391 probe carry trailing ASCII-
 *      space padding; emit byte-for-byte without `.trim()`.
 *      **Forty-second cohort plugin to omit D-10**.
 *
 *   5. **D-11 — omitted (clean pass-through).** 0 of 2
 *      unique wire department names padded; wire
 *      `departments[0].name` flows through byte-for-byte.
 *      **108th cohort plugin with fully-clean department
 *      pass-through.**
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/acp/jobs';

@SourcePlugin({
  site: Site.ACP,
  name: 'ACP',
  category: 'company',
})
@Injectable()
export class AcpService implements IScraper {
  private readonly logger = new Logger(AcpService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`ACP: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10 omitted (clean pass-through): 0/3 wire titles
        // padded — emit byte-for-byte without `.trim()`.
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
        const id = `acp-${jobId}`;

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
            site: Site.ACP,
            title,
            // D-09 pass-through: wire `'Academy with
            // Community Partners'` (second-cohort acronym-
            // by-initials slug-derivation co-form).
            companyName:
              listing.company_name ?? 'Academy with Community Partners',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/acp/jobs/${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            // D-11 omitted (clean pass-through): 0/2 unique
            // departments padded; wire flows through byte-
            // for-byte without `.trim()` overlay.
            department: listing.departments?.[0]?.name ?? null,
          }),
        );
      }

      this.logger.log(`ACP: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`ACP scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
