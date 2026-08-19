import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Formlabs, Inc. — operator of the **dominant desktop-and-
 * benchtop SLA / SLS resin-and-powder 3D-printing platform
 * pioneered around the consumer-and-pro-grade additive-
 * manufacturing data model** (founded by Maxim Lobovsky,
 * Natan Linder, and David Cranor in 2011 as an MIT Media Lab
 * spin-out; private since the 2021 Series E round at ~$2B
 * unicorn valuation; ships Form 4 and Form 4L (SLA
 * stereolithography printers), Fuse 1+ 30W (SLS selective-
 * laser-sintering printer), Form Auto and Build Platform 2
 * (automation / post-processing), and PreForm slicer
 * software across the desktop-3D-printing / additive-
 * manufacturing / pro-prototyping vertical — alongside
 * competitors Stratasys, 3D Systems, Markforged, Carbon, and
 * Ultimaker — with a hybrid distributed workforce
 * concentrated across Somerville MA (HQ), Berlin, Tokyo, and
 * Remote across the United States, Europe, and APAC) —
 * publishes its consolidated careers board through Greenhouse
 * at the bare slug `formlabs` (case-symmetric with the wire
 * `company_name === 'Formlabs'`; see Spec 147 § 10 D-09).
 *
 * **One structural deviation from the Doximity (Spec 127)
 * template** — D-04 sub-axis (variant 2 → variant 40 first
 * cohort observation; careers-subdomain action-leaf dual-id
 * form).
 *
 *   - **D-04 — wire-shape variant 40 (careers-subdomain
 *     `/job/<id>/apply/` action-leaf dual-id — first cohort
 *     observation).** Formlabs publishes `absolute_url` on
 *     `https://careers.formlabs.com/job/<id>/apply/?gh_jid=<id>`
 *     — HTTPS + careers-subdomain (`careers.formlabs.com`) +
 *     `/job/<id>/apply/` (singular leaf with `/apply/`
 *     action segment trailing the path-id; trailing slash) +
 *     dual-id (path-id + query-id). **Sister to variant 26**
 *     (HelloFresh) by careers-subdomain prefix and **sister
 *     to variant 28** (SoFi) by dual-id form, distinct from
 *     both by the `/apply/` action-segment trailing the
 *     path-id. The **forty-third distinct wire-shape variant**
 *     in the company-direct cohort.
 *
 *     The plugin emits `listing.absolute_url` byte-for-byte.
 *     The **fallback** `jobUrl` constructor defaults to the
 *     canonical Greenhouse **variant-2** form
 *     `https://job-boards.greenhouse.io/formlabs/jobs/<id>`
 *     rather than reconstructing the careers-subdomain
 *     action-leaf shape.
 *
 *   - **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     **One-hundred-and-third** plugin to apply D-08.
 *
 *   - **D-09 — brand-name trim omitted (case-symmetric).** Wire
 *     `company_name === 'Formlabs'` byte-for-byte (8 bytes —
 *     fully clean, case-symmetric with the lowercase 8-byte
 *     slug `formlabs` after casefold). 0 of 189 padded.
 *     **Ninety-fourth cohort plugin to omit D-09**.
 *
 *   - **D-10 — wire-title `.trim()` applied (mixed pad form).**
 *     13 of 189 wire titles in the run-357 probe carry pad
 *     bytes (~6.9 % pad rate). **First cohort observation
 *     of triple-trailing-space pad form** — the title
 *     `'Robotic Systems Integration Engineer (SLA & SLS)   '`
 *     carries 3 ASCII spaces at the tail (twice across two
 *     listings); distinct from Justworks (Spec 129) double-
 *     trailing-space pad sub-axis. Plus 1 leading-pad title
 *     (`' 3D Print Optimization Engineer'` — single leading
 *     space; **fourth cohort observation of leading-pad sub-
 *     axis** after Chainguard / Oscar / Celonis). `.trim()`
 *     is byte-count agnostic and handles all pad widths and
 *     positions transparently. **Sixty-fourth cohort plugin
 *     to apply D-10**.
 *
 *   - **D-11 — fully-clean department pass-through.** 0 of 189
 *     wire department names padded across 16 unique
 *     departments (`'Customer Strategy & Operations'`,
 *     `'Finance'`, `'Form Now'`, `'Global Marketing'`,
 *     `'Global Sales'`, `'Global Services'`, `'Hardware
 *     Engineering'`, `'Legal'`, `'Manufacturing'`, `'Materials
 *     Engineering'`, `'Operations'`, `'People & Culture'`,
 *     `'Product'`, `'Software Engineering'`, `'Spectra'`,
 *     `'Systems'` — clean multi-token forms with internal
 *     whitespace and ampersands). Pass-through preserves byte-
 *     for-byte. **Eighty-second cohort plugin** with fully-
 *     clean department pass-through.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/formlabs/jobs';

@SourcePlugin({
  site: Site.FORMLABS,
  name: 'Formlabs',
  category: 'company',
})
@Injectable()
export class FormlabsService implements IScraper {
  private readonly logger = new Logger(FormlabsService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Formlabs: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10 applied (mixed pad form): 13/189 wire titles
        // padded (~6.9 %) — incl. 1 sample with TRIPLE
        // trailing space and 1 leading-pad sample. `.trim()`
        // strips all whitespace at both ends transparently.
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
        const id = `formlabs-${jobId}`;

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
            site: Site.FORMLABS,
            title,
            // D-09 omitted: case-symmetric bare-brand wire.
            companyName: listing.company_name ?? 'Formlabs',
            // D-04: wire `absolute_url` flows through (variant 40).
            // Fallback uses canonical Greenhouse variant-2 form.
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/formlabs/jobs/${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            // D-11 omitted: 0/189 wire departments padded.
            department: listing.departments?.[0]?.name ?? null,
          }),
        );
      }

      this.logger.log(`Formlabs: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Formlabs scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
