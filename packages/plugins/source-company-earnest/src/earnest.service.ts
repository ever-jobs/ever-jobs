import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Earnest Operations LLC — operator of the **dominant US-
 * domestic refinance + private student-loan + personal-loan
 * direct-lender pioneered around the holistic-creditworthiness
 * data model** (founded by Louis Beryl and Benjamin Hutchinson
 * in 2013 in San Francisco, CA; acquired by Navient in 2017
 * for $155M; ships Earnest Refinance, Private Student Loans,
 * and Personal Loans across the consumer-fintech / student-
 * lending vertical — alongside competitors SoFi, CommonBond,
 * LendKey, College Ave, and Splash Financial — with a hybrid
 * distributed workforce concentrated across San Francisco
 * (HQ), New York, and Remote across the United States) —
 * publishes its consolidated careers board through Greenhouse
 * at the bare slug `earnest` (case-symmetric with the wire
 * `company_name === 'Earnest'`; see Spec 144 § 10 D-09).
 *
 * **One structural deviation from the Melio (Spec 130)
 * template** — D-04 sub-axis (variant 2 → variant 39 first
 * cohort observation; first cohort observation of third-party
 * careers-proxy host as a wire-shape variant).
 *
 *   - **D-04 — wire-shape variant 39 (third-party careers-
 *     proxy host — first cohort observation).** Earnest
 *     publishes `absolute_url` on
 *     `https://app.careerpuck.com/job-board/earnest/job/<id>?gh_jid=<id>`
 *     — HTTPS + third-party host (`app.careerpuck.com` —
 *     CareerPuck careers-proxy SaaS, distinct from Greenhouse,
 *     brand-vanity-domains, and `boards.greenhouse.io` legacy
 *     apex) + `/job-board/<slug>/job/<id>` slug-in-path +
 *     dual-id (path-id + query-id). **First cohort observation
 *     of third-party careers-proxy host as a wire-shape
 *     variant** — every prior 41 variants used either
 *     Greenhouse-controlled hosts or brand-vanity-domains.
 *     The **forty-second distinct wire-shape variant** in the
 *     company-direct cohort.
 *
 *     The plugin emits `listing.absolute_url` byte-for-byte.
 *     The **fallback** `jobUrl` constructor defaults to the
 *     canonical Greenhouse **variant-2** form
 *     `https://job-boards.greenhouse.io/earnest/jobs/<id>`
 *     rather than reconstructing the third-party-host shape.
 *
 *   - **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     **One-hundredth cohort plugin to apply D-08 — the cohort
 *     crosses the 100-plugin D-08-application threshold at
 *     this run.**
 *
 *   - **D-09 — brand-name trim omitted (case-symmetric).** Wire
 *     `company_name === 'Earnest'` byte-for-byte (7 bytes —
 *     fully clean, case-symmetric with the lowercase 7-byte
 *     slug `earnest` after casefold). 0 of 11 padded.
 *     **Ninety-first cohort plugin to omit D-09**.
 *
 *   - **D-10 — wire-title `.trim()` applied (trailing-pad form).**
 *     1 of 11 wire titles in the run-354 probe carries trailing
 *     ASCII-space padding (~9.1 % pad rate; `'Director of
 *     Collections '`). **Sixty-first cohort plugin to apply
 *     D-10**.
 *
 *   - **D-11 — wire-dept `.trim()` applied (trailing-pad form).**
 *     1 of 7 unique wire department names padded
 *     (`'Engineering '`); listing-level pad rate 1 of 11
 *     (~9.1 %). The plugin applies `.trim()` to the wire
 *     `departments[0].name` byte-for-byte before downstream
 *     emit. **Fourteenth cohort plugin to apply D-11**.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/earnest/jobs';

@SourcePlugin({
  site: Site.EARNEST,
  name: 'Earnest',
  category: 'company',
})
@Injectable()
export class EarnestService implements IScraper {
  private readonly logger = new Logger(EarnestService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Earnest: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10 applied (trailing-pad form): 1/11 wire titles
        // padded (~9.1 %).
        const title = (listing.title ?? '').trim();
        if (!title) continue;

        // D-11 applied (trailing-pad form): 1/7 unique wire
        // department names padded (`'Engineering '`).
        const department = (listing.departments?.[0]?.name ?? '').trim() || null;

        if (input.searchTerm) {
          const term = input.searchTerm.toLowerCase();
          const titleMatch = title.toLowerCase().includes(term);
          const deptMatch = (department ?? '').toLowerCase().includes(term);
          if (!titleMatch && !deptMatch) continue;
        }

        const jobId = listing.id ?? '';
        const id = `earnest-${jobId}`;

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
            site: Site.EARNEST,
            title,
            // D-09 omitted: case-symmetric bare-brand wire.
            companyName: listing.company_name ?? 'Earnest',
            // D-04: wire `absolute_url` flows through (variant 39).
            // Fallback uses canonical Greenhouse variant-2 form.
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/earnest/jobs/${listing.id}`,
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

      this.logger.log(`Earnest: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Earnest scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
