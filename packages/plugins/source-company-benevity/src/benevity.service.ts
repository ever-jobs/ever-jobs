import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Benevity Inc. — operator of the dominant corporate-purpose
 * SaaS platform pioneered around the workplace-giving-and-
 * volunteering data model (founded by Bryan de Lottinville in
 * 2008 in Calgary; majority-acquired by Hg Capital in December
 * 2020 at a $1.1B valuation; ships an integrated giving-and-
 * volunteering / grants-management / employee-resource-group /
 * DEI-tracking platform across the corporate-purpose segment —
 * alongside competitors YourCause / Bonterra, Submittable,
 * Goodera, and WeSpire — with a hybrid distributed workforce
 * concentrated across Calgary, Toronto, San Francisco, London,
 * and Remote across North America and Europe) — publishes its
 * consolidated careers board through Greenhouse at the bare slug
 * `benevity` (the lowercase brand name; case-symmetric with the
 * wire `company_name === 'Benevity'`; see Spec 091 § 10 D-05).
 *
 * **One structural deviation from the Lookout (Spec 083)
 * template** — D-04 wire-shape variant 23 (first cohort plugin
 * to use variant 23; bare brand-domain + root-level
 * `/job-posting`; distinct from Lookout's variant 20
 * `www.`-prefixed brand-domain + `/careers/job-post`).
 *
 *   1. **D-04 — wire-shape variant 23 (bare brand-domain
 *      `/job-posting` singular-hyphenated query-only-id —
 *      first cohort observation).** Benevity publishes its
 *      `absolute_url` on a previously-unobserved shape
 *      `https://benevity.com/job-posting?gh_jid=<id>` with
 *      three distinguishing sub-axes:
 *      a) **Bare brand-domain `benevity.com`** — same as
 *         variants 13 (Epic Games), 15 (Lattice), 18
 *         (Bitwarden); distinct from variants 16/19/20 which
 *         use `www.` prefix.
 *      b) **No `/careers/` prefix** — Benevity's `/job-posting`
 *         is the entire path segment with no ancestor
 *         `/careers/`. Same root-level positioning as variant
 *         15 (Lattice's `/job`); distinct from variants 13, 18,
 *         19, 20 which all carry `/careers/` as the path-
 *         prefix.
 *      c) **`/job-posting` singular hyphenated** — distinct
 *         from variant 15's bare `/job` (no hyphen, no suffix),
 *         variant 20's `/careers/job-post` (`/careers/` prefix +
 *         slightly-different hyphenated form), and variant
 *         19's `/careers/job` (`/careers/` prefix + bare `/job`).
 *      Single `gh_jid` query parameter. **First** plugin in the
 *      cohort to use **wire-shape variant 23** — the **twenty-
 *      sixth distinct wire-shape variant**.
 *
 *      The plugin emits `listing.absolute_url` byte-for-byte.
 *      The **fallback** `jobUrl` constructor defaults to the
 *      canonical Greenhouse **variant-2** form
 *      `https://job-boards.greenhouse.io/benevity/jobs/<id>`.
 *
 * Shared with Lookout:
 *
 *   - **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     **Forty-seventh** plugin to apply D-08.
 *
 *   - **D-09 — brand-name trim omitted (case-symmetric).** Wire
 *     `company_name === 'Benevity'` byte-for-byte (8 bytes —
 *     fully clean). **Fortieth cohort plugin to omit D-09**.
 *
 *   - **D-10 — wire-title `.trim()` omitted.** 0 of 25 wire
 *     titles in the run-301 probe carry whitespace padding.
 *     **Seventeenth cohort plugin to omit D-10**.
 *
 *   - **D-11 — fully-clean department pass-through.** 0 of 25
 *     wire department names padded (`'Engineering'`, `'Sales'`,
 *     `'Growth Marketing'`, `'Technology Operations'`,
 *     `'Finance'` — clean multi-token forms). **Thirty-sixth
 *     cohort plugin** with fully-clean department pass-through.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/benevity/jobs';

@SourcePlugin({
  site: Site.BENEVITY,
  name: 'Benevity',
  category: 'company',
})
@Injectable()
export class BenevityService implements IScraper {
  private readonly logger = new Logger(BenevityService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Benevity: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10 omitted: 0/25 wire titles padded — pass through.
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
        const id = `benevity-${jobId}`;

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
            site: Site.BENEVITY,
            title,
            // D-09 omitted: case-symmetric bare-brand wire.
            companyName: listing.company_name ?? 'Benevity',
            // D-04: wire `absolute_url` flows through (variant 23
            // — bare brand-domain `/job-posting`); fallback uses
            // canonical Greenhouse variant-2 form.
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/benevity/jobs/${listing.id}`,
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

      this.logger.log(`Benevity: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Benevity scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
