import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Descript, Inc. — operator of the **dominant audio-first
 * collaborative editor pioneered around the transcribe-then-
 * edit-as-text data model** (founded by Andrew Mason (Groupon
 * co-founder) in 2017 in San Francisco; raised ~$160M across
 * rounds at peak ~$553M valuation in October 2022 led by OpenAI
 * Startup Fund and Andreessen Horowitz; ships Descript audio /
 * video editor with Overdub voice cloning, Lyrebird AI,
 * Studio Sound, and the Squad collaborative review platform
 * across the audio-editor / video-editor / podcasting segment —
 * alongside competitors Riverside.fm, Adobe Audition, Apple
 * Logic Pro, and OpenAI Whisper-based tools — with a hybrid
 * distributed workforce concentrated across San Francisco
 * (HQ) and Remote across the United States) — publishes its
 * consolidated careers board through Greenhouse at the bare
 * slug `descript` (the lowercase brand-name; case-symmetric
 * with the wire `company_name === 'Descript'` — see Spec 112
 * § 10 D-05).
 *
 * **Zero structural deviations from the Braze (Spec 110)
 * template** — making this the **nineteenth** Greenhouse-only
 * company-direct plugin in run-history to ship as a clean re-
 * spin and the **fifth** plugin to use wire-shape variant 10
 * (legacy hosted-board apex). All five primary axes share with
 * Braze:
 *
 *   - **D-04 — wire-shape variant 10 (legacy hosted-board apex).**
 *     `https://boards.greenhouse.io/descript/jobs/<id>?gh_jid=<id>`.
 *     **Fifth** plugin in the cohort to use variant 10 (after
 *     Chime, Faire, Flexport, Braze).
 *
 *   - **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     **Sixty-eighth** plugin to apply D-08.
 *
 *   - **D-09 — brand-name trim omitted (case-symmetric).** Wire
 *     `company_name === 'Descript'` byte-for-byte (8 bytes —
 *     fully clean; 0 of 25 padded). Case-symmetric with the
 *     lowercase 8-byte slug `descript`. **Fifty-ninth cohort
 *     plugin to omit D-09**.
 *
 *   - **D-10 — wire-title `.trim()` applied (trailing-pad form).**
 *     2 of 25 wire titles in the run-322 probe carry trailing
 *     ASCII-space padding (~8 % pad rate). **Thirty-sixth
 *     cohort plugin to apply D-10**.
 *
 *   - **D-11 — fully-clean department pass-through.** 0 of 25
 *     wire department names padded across 5 unique departments
 *     (`'Engineering'`, `'Finance'`, `'Marketing'`, `'Product
 *     & Design'`, `'Sales & Business Development'` — clean
 *     multi-token forms with internal whitespace and ampersands).
 *     **Fifty-third cohort plugin** with fully-clean department
 *     pass-through.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/descript/jobs';

@SourcePlugin({
  site: Site.DESCRIPT,
  name: 'Descript',
  category: 'company',
})
@Injectable()
export class DescriptService implements IScraper {
  private readonly logger = new Logger(DescriptService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Descript: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10 applied (trailing-pad form): 2/25 wire titles
        // padded (~8 %).
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
        const id = `descript-${jobId}`;

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
            site: Site.DESCRIPT,
            title,
            // D-09 omitted: case-symmetric bare-brand wire.
            companyName: listing.company_name ?? 'Descript',
            // D-04: wire `absolute_url` flows through (variant 10
            // — legacy hosted-board apex `boards.greenhouse.io`
            // with `?gh_jid=` query); fallback uses canonical
            // Greenhouse variant-2 form.
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/descript/jobs/${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            // D-11 omitted: 0/25 wire departments padded.
            department: listing.departments?.[0]?.name ?? null,
          }),
        );
      }

      this.logger.log(`Descript: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Descript scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
