import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Quanata, LLC (Quanata.com) — operator of the **State-Farm-
 * sponsored connected-mobility insurance-tech platform
 * pioneered around the auto-telematics-risk-modeling data
 * model** (founded as BlueOwl Technologies in 2016 in San
 * Francisco; rebranded to Quanata in 2022 following a $50M
 * majority investment by State Farm Insurance; ships the HiRoad
 * usage-based-auto-insurance product, the Drive Safe & Save
 * telematics program (in partnership with State Farm), the
 * Steer auto-insurance white-label platform, and the Quanata
 * AI Insurance Studio (data-science / actuarial-modeling /
 * MLOps tooling for partner carriers) across the connected-
 * mobility / usage-based-auto-insurance / auto-telematics-
 * risk-modeling segment — alongside competitors Cambridge
 * Mobile Telematics, Zendrive, Arity (Allstate), Octo
 * Telematics, and the in-house telematics arms of Progressive
 * (Snapshot) and Geico (DriveEasy) — with a fully-remote-US
 * workforce concentrated across San Francisco (HQ), Boston,
 * and Remote across the United States) — publishes its
 * consolidated careers board through Greenhouse at the bare
 * slug `quanata` (case-symmetric with the wire
 * `company_name === 'Quanata'`; see Spec 166 § 10 D-05).
 *
 * **Zero structural deviations from the Iterable (Spec 159)
 * template** — case-symmetric brand wire, variant 2 URL,
 * D-08 entity-decode-then-tag-strip, D-10 leading-pad
 * applied, D-11 omitted. **Forty-eighth clean re-spin** in
 * run-history.
 *
 *   1. **D-04 — wire-shape variant 2 (canonical Greenhouse host).**
 *     `https://job-boards.greenhouse.io/quanata/jobs/<id>`.
 *     **Seventieth** plugin in the cohort to use variant 2.
 *
 *   2. **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     **One-hundred-and-twenty-second** plugin to apply D-08.
 *
 *   3. **D-09 — brand-name trim omitted (case-symmetric).** Wire
 *     `company_name === 'Quanata'` byte-for-byte (7 bytes —
 *     fully clean, case-symmetric with the lowercase 7-byte
 *     slug `quanata`). **One-hundred-and-thirteenth cohort
 *     plugin to omit D-09**.
 *
 *   4. **D-10 — wire-title `.trim()` APPLIED (leading-pad
 *      form).** 1 of 10 wire titles in the run-376 probe
 *      carries leading ASCII-space padding (~10 % pad rate —
 *      `' Staff Accountant [Remote-US]'`). The plugin applies
 *      `.trim()` to the wire `title` byte-for-byte before
 *      downstream emit. **9th cohort observation of leading-
 *      pad sub-axis** after Chainguard / Oscar / Celonis /
 *      Formlabs / GoFundMe / BitGo / Instabase / Iterable.
 *      **Seventy-sixth cohort plugin to apply D-10**.
 *
 *   5. **D-11 — wire-department `.trim()` omitted (clean wire).**
 *     0 of 6 unique wire department names padded
 *     (`'Actuarial Operations and Risk Management'`,
 *     `'Engineering'`, `'Finance'`, `'Operations'`,
 *     `'Security'`, `'Talent Community'`); the plugin applies
 *     `.trim()` defensively as a safe no-op. **Ninety-eighth
 *     cohort plugin** with fully-clean department pass-through.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/quanata/jobs';

@SourcePlugin({
  site: Site.QUANATA,
  name: 'Quanata',
  category: 'company',
})
@Injectable()
export class QuanataService implements IScraper {
  private readonly logger = new Logger(QuanataService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Quanata: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10 applied (leading-pad form): 1/10 padded.
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
        const id = `quanata-${jobId}`;

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
            site: Site.QUANATA,
            title,
            // D-09 omitted: case-symmetric bare-brand wire.
            companyName: listing.company_name ?? 'Quanata',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/quanata/jobs/${listing.id}`,
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

      this.logger.log(`Quanata: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Quanata scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
