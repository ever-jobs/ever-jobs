import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Conviva, Inc. — operator of the **dominant cross-screen
 * video streaming-quality measurement and analytics platform
 * pioneered around the longitudinal-streaming-telemetry data
 * model** (founded by Hui Zhang in 2006 in Foster City, CA;
 * private since the 2007 NEA + 2009 Foundation Capital + 2018
 * PE-led recapitalisation; ships Conviva Sensor (client-side
 * video QoE/QoS instrumentation), Stream Sensor (server-side
 * streaming-pipeline telemetry), Operations & Marketing
 * Intelligence (real-time engagement / churn dashboards), and
 * Conviva Touchstone (state-aware experience-quality
 * benchmarking) across the streaming-media-analytics / video-
 * QoE / OTT-operations vertical — alongside competitors NPAW
 * (formerly NicePeopleAtWork), Mux, Datazoom, and Streaming
 * Video Alliance — with a hybrid distributed workforce
 * concentrated across Foster City CA (HQ), London, Bangalore,
 * and Remote across the United States, Europe, and India) —
 * publishes its consolidated careers board through Greenhouse
 * at the bare slug `conviva` (case-symmetric with the wire
 * `company_name === 'Conviva'`; see Spec 142 § 10 D-09).
 *
 * **One structural deviation from the Lookout (Spec 083)
 * template** — D-04 sub-axis (variant 20 query-only-id with
 * `-post` suffix → variant 37 dual-id with bare singular-leaf
 * path).
 *
 *   - **D-04 — wire-shape variant 37 (`www.`-prefixed brand-
 *     domain singular-leaf path-id dual-id — first cohort
 *     observation).** Conviva publishes `absolute_url` on
 *     `https://www.conviva.com/careers/job/<id>?gh_jid=<id>`
 *     — HTTPS + `www.`-prefixed brand-domain + `/careers/job/<id>`
 *     (singular leaf with id-in-path) + dual-id (path-id +
 *     query-id). **Sister to variant 19** (Klaviyo / Fivetran /
 *     Amplitude) by `www.`-prefix and singular-leaf base form;
 *     **sister to variant 28** (SoFi) by singular-leaf + id-
 *     in-path + dual-id form. Distinct from both by combining
 *     all three shape elements (www-prefix + singular-leaf +
 *     path-id + dual-id) for the first time. **First** plugin
 *     in the cohort to use **wire-shape variant 37** — the
 *     **fortieth distinct wire-shape variant** in the company-
 *     direct cohort.
 *
 *     The plugin emits `listing.absolute_url` byte-for-byte.
 *     The **fallback** `jobUrl` constructor defaults to the
 *     canonical Greenhouse **variant-2** form
 *     `https://job-boards.greenhouse.io/conviva/jobs/<id>`
 *     rather than reconstructing the vanity-domain shape
 *     (same defence-in-depth strategy as ClassPass / Epic
 *     Games / Lookout / SoFi).
 *
 *   - **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     **Ninety-eighth** plugin to apply D-08.
 *
 *   - **D-09 — brand-name trim omitted (case-symmetric).** Wire
 *     `company_name === 'Conviva'` byte-for-byte (7 bytes —
 *     fully clean, case-symmetric with the lowercase 7-byte
 *     slug `conviva` after casefold). 0 of 9 padded.
 *     **Eighty-ninth cohort plugin to omit D-09**.
 *
 *   - **D-10 — wire-title `.trim()` omitted.** 0 of 9 wire
 *     titles in the run-352 probe carry pad bytes. The plugin
 *     emits `listing.title` byte-for-byte without a `.trim()`.
 *     **Twenty-seventh cohort plugin to omit D-10**.
 *
 *   - **D-11 — fully-clean department pass-through.** 0 of 9
 *     wire department names padded across 5 unique departments
 *     (`'Customer Support'`, `'Finance'`, `'Product Management'`,
 *     `'Sales'`, `'Technical Solutions'` — clean multi-token
 *     forms with internal whitespace). Pass-through preserves
 *     byte-for-byte. **Seventy-ninth cohort plugin** with
 *     fully-clean department pass-through.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/conviva/jobs';

@SourcePlugin({
  site: Site.CONVIVA,
  name: 'Conviva',
  category: 'company',
})
@Injectable()
export class ConvivaService implements IScraper {
  private readonly logger = new Logger(ConvivaService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Conviva: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10 omitted: 0/9 wire titles padded (no .trim()
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
        const id = `conviva-${jobId}`;

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
            site: Site.CONVIVA,
            title,
            // D-09 omitted: case-symmetric bare-brand wire.
            companyName: listing.company_name ?? 'Conviva',
            // D-04: wire `absolute_url` flows through (variant 37).
            // Fallback uses canonical Greenhouse variant-2 form.
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/conviva/jobs/${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            // D-11 omitted: 0/9 wire departments padded.
            department: listing.departments?.[0]?.name ?? null,
          }),
        );
      }

      this.logger.log(`Conviva: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Conviva scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
