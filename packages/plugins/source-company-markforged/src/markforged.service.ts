import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Markforged Holding Corporation (Markforged.com) — operator
 * of the **dominant industrial-additive-manufacturing platform
 * pioneered around the continuous-fiber-composite-3D-printing
 * data model** (founded by Greg Mark and David Benhaim in 2013
 * in Watertown, Massachusetts; raised ~$137M across rounds at
 * peak ~$2B valuation in July 2021 via SPAC merger with
 * one-NYSE-listed `MKFG`; ships the Mark Two / X3 / X7 / FX10
 * / FX20 industrial composite printers, the Metal X / PX100
 * metal-binder-jetting line, the Eiger cloud slicer / part-
 * library / fleet-manager, the Digital Forge end-to-end print-
 * orchestration platform, and the Onyx / Onyx FR / Onyx ESD /
 * carbon-fiber / kevlar / fiberglass / HSHT / metal feedstock
 * lines — across the industrial-additive-manufacturing /
 * continuous-fiber-composite / metal-binder-jetting segment —
 * alongside competitors Stratasys, 3D Systems, HP, EOS,
 * Desktop Metal, Velo3D, Carbon, Formlabs, and Ultimaker —
 * with a hybrid distributed workforce concentrated across
 * Watertown, Massachusetts (HQ), Billerica, Massachusetts, and
 * Remote across the United States) — publishes its
 * consolidated careers board through Greenhouse at the bare
 * slug `markforged` (case-symmetric with the wire
 * `company_name === 'Markforged'`; see Spec 161 § 10 D-05).
 *
 * **Zero structural deviations from the Labelbox (Spec 160)
 * template** — case-symmetric brand wire, variant 2 URL,
 * D-08 entity-decode-then-tag-strip, D-10 omitted, D-11
 * omitted. **Forty-fourth clean re-spin** in run-history.
 *
 *   1. **D-04 — wire-shape variant 2 (canonical Greenhouse host).**
 *     `https://job-boards.greenhouse.io/markforged/jobs/<id>`.
 *     **Sixty-sixth** plugin in the cohort to use variant 2.
 *
 *   2. **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     **One-hundred-and-seventeenth** plugin to apply D-08.
 *
 *   3. **D-09 — brand-name trim omitted (case-symmetric).** Wire
 *     `company_name === 'Markforged'` byte-for-byte (10 bytes
 *     — fully clean, case-symmetric with the lowercase 10-byte
 *     slug `markforged`). **One-hundred-and-eighth cohort
 *     plugin to omit D-09**.
 *
 *   4. **D-10 — wire-title `.trim()` omitted (clean wire).**
 *     0 of 6 wire titles padded; the plugin applies `.trim()`
 *     defensively as a safe no-op. **Thirty-fourth cohort
 *     plugin to omit D-10**.
 *
 *   5. **D-11 — wire-department `.trim()` omitted (clean wire).**
 *     0 of 4 unique wire department names padded
 *     (`'Application Engineering'`, `'Engineering'`,
 *     `'Operations Management'`, `'Sales'`); the plugin
 *     applies `.trim()` defensively as a safe no-op.
 *     **Ninety-third cohort plugin** with fully-clean
 *     department pass-through.
 *
 * **Run-371 milestone:** Markforged is the **150th**
 * Greenhouse-backed company-direct plugin in the catalogue —
 * **the cohort crosses the 150-plugin company-direct
 * threshold at this run.**
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/markforged/jobs';

@SourcePlugin({
  site: Site.MARKFORGED,
  name: 'Markforged',
  category: 'company',
})
@Injectable()
export class MarkforgedService implements IScraper {
  private readonly logger = new Logger(MarkforgedService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Markforged: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10 omitted at probe time; .trim() is a safe no-op
        // on clean wire.
        const title = (listing.title ?? '').trim();
        if (!title) continue;

        // D-11 omitted at probe time; .trim() is a safe no-op
        // on clean wire.
        const dept = (listing.departments?.[0]?.name ?? '').trim() || null;

        if (input.searchTerm) {
          const term = input.searchTerm.toLowerCase();
          const titleMatch = title.toLowerCase().includes(term);
          const deptMatch = (dept ?? '').toLowerCase().includes(term);
          if (!titleMatch && !deptMatch) continue;
        }

        const jobId = listing.id ?? '';
        const id = `markforged-${jobId}`;

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
            site: Site.MARKFORGED,
            title,
            // D-09 omitted: case-symmetric bare-brand wire.
            companyName: listing.company_name ?? 'Markforged',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/markforged/jobs/${listing.id}`,
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

      this.logger.log(`Markforged: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Markforged scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
