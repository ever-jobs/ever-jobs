import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Fox Creek Veterinary Hospital - Wildwood — operator of a
 * **veterinary-specialty animal-hospital + urgent-care
 * practice pioneered around the multi-disciplinary companion-
 * animal clinical-care data model** (an independent veterinary
 * hospital practice in the Wildwood region; ships small-
 * animal medicine, surgery, urgent care, dentistry, and
 * rehabilitation services across the consumer-veterinary /
 * companion-animal-care vertical) — publishes its
 * consolidated careers board through Greenhouse at the bare
 * slug `fox` (case-asymmetric vs the wire `company_name ===
 * 'Fox Creek Veterinary Hospital - Wildwood'` — slug truncates
 * the wire to the first token only; see Spec 149 § 10 D-09).
 *
 * **Zero structural deviations from the BEAM (Spec 136)
 * template** — making this the **thirty-eighth** Greenhouse-
 * only company-direct plugin in run-history to ship as a
 * clean re-spin. All five primary axes share with BEAM, with
 * a notable D-09 sub-axis observation:
 *
 *   - **D-04 — wire-shape variant 2 (canonical Greenhouse host).**
 *     `https://job-boards.greenhouse.io/fox/jobs/<id>`.
 *     **Fifty-seventh** plugin in the cohort to use variant 2.
 *
 *   - **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     **One-hundred-and-fifth** plugin to apply D-08.
 *
 *   - **D-09 — brand-name trim omitted with FOURTH-COHORT
 *     slug-truncation asymmetric wire form.** Wire
 *     `company_name === 'Fox Creek Veterinary Hospital -
 *     Wildwood'` byte-for-byte (40 bytes — six-token legal-
 *     entity name with internal whitespace and hyphen
 *     separator). Slug `fox` is 3 bytes lowercase — matches
 *     the first token only; truncates 5 trailing tokens
 *     (`Creek Veterinary Hospital - Wildwood`). **Fourth
 *     cohort observation of slug-truncation D-09 sub-axis**
 *     after Oscar (Spec 133 — slug-extra-word, 1 token added),
 *     BEAM (Spec 136 — slug-acronym-expansion), and Founders
 *     (Spec 148 — 4 tokens dropped). **Fox has the NEW
 *     largest slug-token-truncation factor in cohort to date**
 *     — 5 tokens dropped beyond the slug-matching first
 *     token, exceeding Founders's prior record of 4. **Ninety-
 *     sixth cohort plugin to omit D-09**.
 *
 *   - **D-10 — wire-title `.trim()` omitted.** 0 of 5 wire
 *     titles in the run-359 probe carry pad bytes. The plugin
 *     emits `listing.title` byte-for-byte without a `.trim()`.
 *     **Thirtieth cohort plugin to omit D-10 — the cohort
 *     crosses the 30-plugin D-10-omission threshold at this
 *     run.**
 *
 *   - **D-11 — fully-clean department pass-through.** 0 of 5
 *     wire department names padded across 4 unique
 *     departments (`'Externships'`, `'Reception'`,
 *     `'Technicians'`, `'Veterinary Doctors'` — clean single-
 *     token / two-token forms). Pass-through preserves byte-
 *     for-byte. **Eighty-fourth cohort plugin** with fully-
 *     clean department pass-through.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/fox/jobs';

@SourcePlugin({
  site: Site.FOX,
  name: 'Fox Creek Veterinary Hospital - Wildwood',
  category: 'company',
})
@Injectable()
export class FoxService implements IScraper {
  private readonly logger = new Logger(FoxService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Fox: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10 omitted: 0/5 wire titles padded (no .trim()
        // applied — wire is fully clean).
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
        const id = `fox-${jobId}`;

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
            site: Site.FOX,
            title,
            // D-09 omitted: slug-truncation asymmetric wire
            // form `'Fox Creek Veterinary Hospital - Wildwood'`.
            companyName: listing.company_name ?? 'Fox Creek Veterinary Hospital - Wildwood',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/fox/jobs/${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            // D-11 omitted: 0/5 wire departments padded.
            department: listing.departments?.[0]?.name ?? null,
          }),
        );
      }

      this.logger.log(`Fox: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Fox scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
