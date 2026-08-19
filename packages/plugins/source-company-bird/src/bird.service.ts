import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Bird Rides, Inc. — operator of the **shared-electric-
 * scooter micromobility / dockless-vehicle-rental platform
 * pioneered around the consumer-fleet-rental data model**
 * (founded by Travis VanderZanden in 2017 in Santa Monica,
 * CA; Nasdaq-listed via 2021 SPAC merger then went private
 * 2023 in restructuring at a substantially reduced
 * valuation; ships Bird app (rider-side), Bird One / Three
 * (vehicle hardware generations), and operations / fleet-
 * management infrastructure across the consumer-
 * micromobility / shared-mobility / dockless-e-scooter
 * vertical — alongside competitors Lime, Spin (Ford), Voi,
 * and Tier — with a hybrid distributed workforce
 * concentrated across Santa Monica (HQ), Miami, and field
 * offices across the United States and Europe) — publishes
 * its consolidated careers board through Greenhouse at the
 * bare slug `bird` (case-symmetric with the wire
 * `company_name === 'Bird'`; see Spec 153 § 10 D-09).
 *
 * **One structural deviation from the Doximity (Spec 127)
 * template** — D-04 sub-axis (variant 2 → variant 41 first
 * cohort observation; `.co` TLD careers-list-page query-
 * only-id form).
 *
 *   - **D-04 — wire-shape variant 41 (`www.`-prefixed `.co`-
 *     TLD careers-list-page query-only-id — first cohort
 *     observation).** Bird publishes `absolute_url` on
 *     `https://www.bird.co/careers?gh_jid=<id>` — HTTPS +
 *     `www.`-prefixed brand-domain on **`.co` TLD** +
 *     `/careers` careers-list-page path (no job-leaf) +
 *     query-only-id. **First cohort observation of `.co`
 *     TLD on a vanity-domain** — the **forty-fourth
 *     distinct wire-shape variant** in the company-direct
 *     cohort. Sister to variant 19 (Klaviyo) by `www.`-
 *     prefix and query-only-id; distinct from variant 19 by
 *     `.co` TLD vs `.com`, by `/careers` path (no `/jobs`
 *     leaf), and by serving a careers-list page rather than
 *     a job-detail page (the `gh_jid` query is resolved
 *     client-side).
 *
 *     The plugin emits `listing.absolute_url` byte-for-byte.
 *     The **fallback** `jobUrl` constructor defaults to the
 *     canonical Greenhouse **variant-2** form
 *     `https://job-boards.greenhouse.io/bird/jobs/<id>`.
 *
 *   - **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     **One-hundred-and-ninth** plugin to apply D-08.
 *
 *   - **D-09 — brand-name trim omitted (case-symmetric).** Wire
 *     `company_name === 'Bird'` byte-for-byte (4 bytes —
 *     fully clean, case-symmetric with the lowercase 4-byte
 *     slug `bird` after casefold). 0 of 39 padded.
 *     **One-hundredth cohort plugin to omit D-09 — the cohort
 *     crosses the 100-plugin D-09-omission threshold at this
 *     run.**
 *
 *   - **D-10 — wire-title `.trim()` applied (trailing-pad form).**
 *     1 of 39 wire titles in the run-363 probe carries
 *     trailing ASCII-space padding (~2.6 % pad rate; `'Vehicle
 *     Mechanic - Bronx, NY '`). **Sixty-eighth cohort plugin
 *     to apply D-10**.
 *
 *   - **D-11 — fully-clean department pass-through.** 0 of 39
 *     wire department names padded across 2 unique
 *     departments (`'Contractor'`, `'Operations'` — clean
 *     single-token forms). **Eighty-seventh cohort plugin**
 *     with fully-clean department pass-through.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/bird/jobs';

@SourcePlugin({
  site: Site.BIRD,
  name: 'Bird',
  category: 'company',
})
@Injectable()
export class BirdService implements IScraper {
  private readonly logger = new Logger(BirdService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Bird: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10 applied (trailing-pad form): 1/39 wire titles
        // padded (~2.6 %).
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
        const id = `bird-${jobId}`;

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
            site: Site.BIRD,
            title,
            // D-09 omitted: case-symmetric bare-brand wire.
            companyName: listing.company_name ?? 'Bird',
            // D-04: wire `absolute_url` flows through (variant 41).
            // Fallback uses canonical Greenhouse variant-2 form.
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/bird/jobs/${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            // D-11 omitted: 0/39 wire departments padded.
            department: listing.departments?.[0]?.name ?? null,
          }),
        );
      }

      this.logger.log(`Bird: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Bird scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
