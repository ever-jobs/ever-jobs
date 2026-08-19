import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Cribl, Inc. — operator of the **dominant observability-data-
 * pipeline platform pioneered around the vendor-agnostic event-
 * routing data model** (founded by Clint Sharp, Ledion Bitincka,
 * and Dritan Bitincka in 2018 in San Francisco, CA; private
 * since the 2024 Series E round at ~$3.5B valuation; ships
 * Cribl Stream (event-routing / reduction / enrichment), Cribl
 * Edge (agent-based collection), Cribl Search (federated search
 * across SIEM / observability backends), and Cribl Lake (low-
 * cost telemetry storage) across the observability-data-
 * engineering / SIEM-augmentation / telemetry-pipeline vertical
 * — alongside competitors Splunk Edge Processor, Datadog
 * Observability Pipelines, Grafana Beyla, and OpenTelemetry
 * Collector — with a hybrid distributed workforce concentrated
 * across San Francisco (HQ), Austin, Dublin, and Remote across
 * the United States, Europe, and APAC) — publishes its
 * consolidated careers board through Greenhouse at the bare
 * slug `cribl` (case-symmetric with the wire `company_name ===
 * 'Cribl'` after casefold; see Spec 143 § 10 D-09).
 *
 * **One structural deviation from the Lookout (Spec 083)
 * template** — D-04 sub-axis (variant 20 query-only-id with
 * `-post` suffix → variant 38 query-only-id on `.io` TLD with
 * NO `/careers/` ancestor).
 *
 *   - **D-04 — wire-shape variant 38 (`.io`-TLD bare brand-
 *     domain `/job-detail/` query-only-id — first cohort
 *     observation).** Cribl publishes `absolute_url` on
 *     `https://cribl.io/job-detail/?gh_jid=<id>` — HTTPS +
 *     bare brand-domain on **`.io` TLD** + `/job-detail/`
 *     trailing-slash leaf with hyphen + query-only-id (no
 *     id-in-path). **First cohort observation of `.io` TLD**
 *     on a vanity-domain (all 40 prior variants used `.com`
 *     or legacy `boards.greenhouse.io` apex). **First cohort
 *     observation of NO-`/careers/` ancestor** on a vanity-
 *     domain (every prior bare-brand vanity-domain variant
 *     included `/careers/` in the path). The **forty-first
 *     distinct wire-shape variant** in the company-direct
 *     cohort.
 *
 *     The plugin emits `listing.absolute_url` byte-for-byte.
 *     The **fallback** `jobUrl` constructor defaults to the
 *     canonical Greenhouse **variant-2** form
 *     `https://job-boards.greenhouse.io/cribl/jobs/<id>`
 *     rather than reconstructing the vanity-domain shape
 *     (same defence-in-depth strategy as ClassPass / Epic
 *     Games / Lookout / Conviva).
 *
 *   - **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     **Ninety-ninth** plugin to apply D-08.
 *
 *   - **D-09 — brand-name trim omitted (case-symmetric).** Wire
 *     `company_name === 'Cribl'` byte-for-byte (5 bytes —
 *     fully clean, case-symmetric with the lowercase 5-byte
 *     slug `cribl` after casefold). 0 of 51 padded.
 *     **Ninetieth cohort plugin to omit D-09 — the cohort
 *     crosses the 90-plugin D-09-omission threshold at this
 *     run.**
 *
 *   - **D-10 — wire-title `.trim()` omitted.** 0 of 51 wire
 *     titles in the run-353 probe carry pad bytes. The plugin
 *     emits `listing.title` byte-for-byte without a `.trim()`.
 *     **Twenty-eighth cohort plugin to omit D-10**.
 *
 *   - **D-11 — fully-clean department pass-through.** 0 of 51
 *     wire department names padded across 9 unique departments
 *     (`'Customer Experience'`, `'Engineering'`, `'Finance'`,
 *     `'IT & Security'`, `'Marketing'`, `'Operations'`,
 *     `'People'`, `'Sales'`, `'Support'` — clean multi-token
 *     forms with internal whitespace and ampersands). Pass-
 *     through preserves byte-for-byte. **Eightieth cohort
 *     plugin** with fully-clean department pass-through —
 *     **the cohort crosses the 80-plugin D-11-omission
 *     threshold at this run**.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/cribl/jobs';

@SourcePlugin({
  site: Site.CRIBL,
  name: 'Cribl',
  category: 'company',
})
@Injectable()
export class CriblService implements IScraper {
  private readonly logger = new Logger(CriblService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Cribl: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10 omitted: 0/51 wire titles padded (no .trim()
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
        const id = `cribl-${jobId}`;

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
            site: Site.CRIBL,
            title,
            // D-09 omitted: case-symmetric bare-brand wire.
            companyName: listing.company_name ?? 'Cribl',
            // D-04: wire `absolute_url` flows through (variant 38).
            // Fallback uses canonical Greenhouse variant-2 form.
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/cribl/jobs/${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            // D-11 omitted: 0/51 wire departments padded.
            department: listing.departments?.[0]?.name ?? null,
          }),
        );
      }

      this.logger.log(`Cribl: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Cribl scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
