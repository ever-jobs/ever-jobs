import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * American College of Obstetricians and Gynecologists — operator
 * of the **dominant U.S. medical-specialty membership society
 * for obstetrics-and-gynecology clinical practice, evidence-
 * based clinical guidance, and women's-health professional
 * education** providing peer-reviewed clinical practice
 * bulletins, committee opinions, continuing medical education
 * (CME) curricula, board-certification preparation, member-
 * mobilization advocacy for women's reproductive-health policy,
 * and accredited residency-program oversight (founded as the
 * American Association of Obstetricians, Gynecologists, and
 * Abdominal Surgeons in 1888, incorporated as the American
 * College of Obstetricians and Gynecologists in 1951 in
 * Washington, DC; 501(c)(6) tax-exempt professional medical-
 * specialty membership society paired with the ACOG Foundation
 * 501(c)(3) charitable arm; serves 63 000+ ob-gyn physicians,
 * ob-gyn residents-in-training, certified nurse-midwives,
 * women's-health nurse practitioners, and allied medical
 * professionals across all 50 U.S. states plus international
 * fellow chapters; ships *Obstetrics & Gynecology* (the Green
 * Journal) flagship peer-reviewed publication, ACOG Practice
 * Bulletins, ACOG Committee Opinions, ACOG Clinical Practice
 * Guidelines, ACOG CME / MOC II / MOC IV continuing-education
 * programs, ACOG Annual Clinical & Scientific Meeting, and
 * ACOG Patient Education materials across the U.S. medical-
 * specialty membership society / women's-health clinical
 * guidance segment — alongside peer specialty societies
 * American Medical Association, American Academy of Pediatrics,
 * American Academy of Family Physicians, Society for Maternal-
 * Fetal Medicine, American Society for Reproductive Medicine,
 * American Urogynecologic Society, and Society of Gynecologic
 * Oncology — with a hybrid distributed workforce concentrated
 * across Washington, DC (HQ — 409 12th Street SW), and Remote
 * across the United States) — publishes its consolidated
 * careers board through Greenhouse at the bare slug `acog`
 * (wire `company_name === 'American College of Obstetricians
 * and Gynecologists'` — see Spec 179 § 10 D-09).
 *
 * **Two structural deviations from the ACLU (Spec 178)
 * template** —
 *
 *   - **D-09 sub-axis:** all-caps acronym + space-hyphen-
 *     space separator + multi-token suffix → first-token-
 *     only-lowercase slug-truncation (`'ACLU - National
 *     Office'` 22 bytes — 4 wire-tokens, first-token-only-
 *     lowercase, 3 trailing tokens dropped) → **acronym-by-
 *     initials slug derivation from a multi-token PascalCase
 *     + lowercase-connector wire form** (`'American College
 *     of Obstetricians and Gynecologists'` 51 bytes — 6
 *     wire-tokens split by ASCII spaces: 4 PascalCase
 *     (`American`, `College`, `Obstetricians`,
 *     `Gynecologists`) + 2 all-lowercase connectors (`of`,
 *     `and`); slug `acog` formed by sampling the first
 *     letter of each PascalCase wire-token in order,
 *     skipping the 2 lowercase-connector tokens, all
 *     lowercased). **First cohort observation of (a)
 *     acronym-by-initials slug derivation from a multi-
 *     token wire form (no single wire-token contains the
 *     slug as a substring) AND (b) all-lowercase connector-
 *     token skip in slug derivation.**
 *   - **D-11 sub-axis:** trailing-pad applied (1 of 14
 *     unique departments padded) → **clean pass-through** (0
 *     of 6 unique departments padded; wire `departments[0]
 *     .name` flows through byte-for-byte).
 *
 *   1. **D-04 — wire-shape variant 2 (canonical Greenhouse host).**
 *     `https://job-boards.greenhouse.io/acog/jobs/<id>`.
 *     **Seventy-eighth** plugin in the cohort to use variant 2.
 *
 *   2. **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     **One-hundred-and-thirty-fifth** plugin to apply D-08.
 *
 *   3. **D-09 — brand-name omitted at runtime; wire form
 *     pass-through.** Wire `company_name === 'American
 *     College of Obstetricians and Gynecologists'` byte-for-
 *     byte (51 bytes). 6 wire-tokens split by ASCII spaces:
 *     `American` (8-byte PascalCase, cap at byte 0 only),
 *     `College` (7-byte PascalCase, cap at byte 0 only),
 *     `of` (2-byte all-lowercase connector), `Obstetricians`
 *     (13-byte PascalCase, cap at byte 0 only), `and`
 *     (3-byte all-lowercase connector), `Gynecologists`
 *     (13-byte PascalCase, cap at byte 0 only). Slug is
 *     4-byte lowercase `acog` — formed by sampling the
 *     first letter of each PascalCase wire-token in order
 *     (A from American, C from College, O from
 *     Obstetricians, G from Gynecologists), skipping the 2
 *     all-lowercase connector tokens, and lowercasing the
 *     result. **126th cohort plugin to omit D-09.** **First
 *     cohort observation of (a) acronym-by-initials slug
 *     derivation from a multi-token wire form (no single
 *     wire-token contains the slug as a substring) AND (b)
 *     all-lowercase connector-token skip in slug
 *     derivation.**
 *
 *   4. **D-10 — wire-title `.trim()` applied (trailing-pad form).**
 *     1 of 6 wire titles in the run-389 probe carries
 *     trailing ASCII-space padding (~16.7 % pad rate).
 *     **Eighty-second cohort plugin to apply D-10**.
 *
 *   5. **D-11 — omitted (clean pass-through).** 0 of 6
 *     unique wire department names padded; wire
 *     `departments[0].name` flows through byte-for-byte.
 *     **106th cohort plugin with fully-clean department
 *     pass-through.**
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/acog/jobs';

@SourcePlugin({
  site: Site.ACOG,
  name: 'ACOG',
  category: 'company',
})
@Injectable()
export class AcogService implements IScraper {
  private readonly logger = new Logger(AcogService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`ACOG: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10 applied (trailing-pad form): 1/6 wire titles
        // padded (~16.7 %) — e.g., `'Director, Clinical
        // Guidance Methodology '`.
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
        const id = `acog-${jobId}`;

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
            site: Site.ACOG,
            title,
            // D-09 pass-through: wire `'American College of
            // Obstetricians and Gynecologists'` (acronym-by-
            // initials slug-derivation co-form).
            companyName:
              listing.company_name ??
              'American College of Obstetricians and Gynecologists',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/acog/jobs/${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            // D-11 omitted (clean pass-through): 0/6 unique
            // departments padded; wire flows through byte-
            // for-byte without `.trim()` overlay.
            department: listing.departments?.[0]?.name ?? null,
          }),
        );
      }

      this.logger.log(`ACOG: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`ACOG scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
