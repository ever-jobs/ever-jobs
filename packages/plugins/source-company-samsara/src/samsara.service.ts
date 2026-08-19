import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Samsara, Inc. (Samsara.com) — operator of the **dominant
 * Connected Operations / Internet-of-Things-fleet-and-sensor-
 * data platform pioneered around the unified-physical-operations
 * data model** (founded by Sanjit Biswas and John Bicket in
 * 2015 in San Francisco, California; NYSE-listed under ticker
 * `IOT` since December 2021 at peak ~$22B+ public valuation;
 * ships Samsara Connected Operations Cloud (the unified
 * platform), Samsara Vehicle Telematics (GPS + ELD + asset-
 * tracking telemetry), Samsara Video-Based Safety (AI-Dash-Cam
 * driver-coaching), Samsara Equipment Monitoring (industrial-
 * sensor / asset-utilization), Samsara Site Visibility
 * (workplace-safety / facility-monitoring), Samsara Workflows
 * (no-code operational-process automation), Samsara API
 * Platform (developer ecosystem), and Samsara App Marketplace
 * (third-party-integration ecosystem) across the Connected
 * Operations / commercial-vehicle-telematics / industrial-IoT /
 * fleet-management segment — alongside competitors Geotab,
 * Motive (KeepTruckin), Trimble, Verizon Connect, Lytx,
 * Netradyne, and the SaaS-fleet-telematics platforms of Fleet
 * Complete, GPS Insight, and Azuga — with a hybrid distributed
 * workforce concentrated across San Francisco, California (HQ),
 * Atlanta, Georgia, London, United Kingdom, Mexico City,
 * Mexico, and Remote across 30+ countries) — publishes its
 * consolidated careers board through Greenhouse at the bare
 * slug `samsara` but emits `absolute_url` on a previously-
 * unobserved vanity-domain shape (see Spec 168 § 4 D-04).
 *
 * **Two structural deviations from the Netskope (Spec 163)
 * template** — D-04 wire-shape variant 43 → **NEW variant 44
 * (first cohort observation; 47th distinct wire-shape
 * variant)** AND D-10 sub-axis: NEW **same-title both-pad
 * sub-axis observation** (first cohort observation).
 *
 *   - **D-04 — wire-shape variant 44 (`www.`-prefixed `.com`-
 *     TLD 3-segment careers-roles path-id leaf with
 *     duplicating query-id — first cohort observation).**
 *     Samsara publishes `absolute_url` on
 *     `https://www.samsara.com/company/careers/roles/<id>?gh_jid=<id>`
 *     — HTTPS + `www.`-prefix brand-domain on `.com` TLD +
 *     3-segment `/company/careers/roles/<id>` path **with
 *     path-id leaf** + `?gh_jid=<id>` query that **duplicates
 *     the path-id**. **First cohort observation of variant 44**
 *     — the **forty-seventh distinct wire-shape variant** in
 *     the company-direct cohort. Sister to variant 43
 *     (Netskope) by `www.`-prefix `.com`-TLD 3-segment
 *     `/company/careers/...` path; distinct from variant 43
 *     by the path-id leaf + duplicating-query-id form
 *     (variant 43 is careers-list-page trailing-slash +
 *     query-only-id).
 *
 *     The plugin emits `listing.absolute_url` byte-for-byte.
 *     The **fallback** `jobUrl` constructor defaults to the
 *     canonical Greenhouse **variant-2** form
 *     `https://job-boards.greenhouse.io/samsara/jobs/<id>`
 *     because the variant-44 vanity-domain shape may not be
 *     guaranteed-resolvable for all listing IDs (same fallback
 *     strategy as Klaviyo / Bird / Collective Health /
 *     Netskope).
 *
 *   - **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     **One-hundred-and-twenty-fourth** plugin to apply D-08.
 *
 *   - **D-09 — brand-name trim omitted (case-symmetric).** Wire
 *     `company_name === 'Samsara'` byte-for-byte (7 bytes —
 *     fully clean, case-symmetric with the lowercase 7-byte
 *     slug `samsara` after casefold). 0 of 367 padded.
 *     **One-hundred-and-fifteenth cohort plugin to omit D-09**.
 *
 *   - **D-10 — wire-title `.trim()` APPLIED with NEW same-title
 *     both-pad sub-axis observation.** 17 of 367 wire titles
 *     padded (~4.6 % pad rate) split as:
 *       - 3 same-title both-pad — `' Commercial Account Executive '`
 *         x3 — **first cohort observation** of a SINGLE title
 *         carrying ASCII-space pads on BOTH ends simultaneously;
 *       - 4 leading-only-pad — e.g. `' Select Major Account
 *         Executive (CST)'`, `' Solutions Consultant (Engagement
 *         Services Manager)'`;
 *       - 10 trailing-only-pad — e.g. `'Commercial Account
 *         Executive '`.
 *     `.trim()` is symmetric over both ends, so the wire-
 *     implementation byte-for-byte matches all prior trim-
 *     based templates even though the structural sub-axis is
 *     new. **Seventy-seventh cohort plugin to apply D-10**.
 *
 *   - **D-11 — wire-department `.trim()` omitted (clean wire).**
 *     0 of 44 unique wire department names padded — high-
 *     cardinality dept set with internal whitespace,
 *     ampersands, and slashes (`'Account Development
 *     Representative'`, `'Business Systems'`, `'Corporate
 *     Marketing'`, `'Finance and Strategy'`, `'Marketing
 *     Systems & Intelligence'`, `'Sales Engineering'`, `'STCE
 *     & Maintenance'`, plus 37 others); the plugin applies
 *     `.trim()` defensively as a safe no-op. **One-hundredth
 *     cohort plugin** with fully-clean department pass-
 *     through — **the cohort crosses the 100-plugin D-11-
 *     omission threshold at this run.**
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/samsara/jobs';

@SourcePlugin({
  site: Site.SAMSARA,
  name: 'Samsara',
  category: 'company',
})
@Injectable()
export class SamsaraService implements IScraper {
  private readonly logger = new Logger(SamsaraService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Samsara: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10 applied — same-title both-pad + lead-only +
        // trail-only mixed forms; .trim() symmetric.
        const title = (listing.title ?? '').trim();
        if (!title) continue;

        // D-11 omitted at probe time; .trim() is a safe no-op.
        const dept = (listing.departments?.[0]?.name ?? '').trim() || null;

        if (input.searchTerm) {
          const term = input.searchTerm.toLowerCase();
          const titleMatch = title.toLowerCase().includes(term);
          const deptMatch = (dept ?? '').toLowerCase().includes(term);
          if (!titleMatch && !deptMatch) continue;
        }

        const jobId = listing.id ?? '';
        const id = `samsara-${jobId}`;

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
            site: Site.SAMSARA,
            title,
            // D-09 omitted: case-symmetric bare-brand wire.
            companyName: listing.company_name ?? 'Samsara',
            // D-04: wire `absolute_url` flows through (variant 44);
            // fallback defaults to canonical variant-2 Greenhouse
            // form because the variant-44 vanity-domain shape may
            // not be guaranteed-resolvable for all listing IDs
            // (same fallback as Klaviyo / Bird / Collective Health
            // / Netskope).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/samsara/jobs/${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            department: dept,
          }),
        );
      }

      this.logger.log(`Samsara: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Samsara scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
