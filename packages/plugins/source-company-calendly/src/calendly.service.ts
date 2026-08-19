import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Calendly LLC — operator of the dominant scheduling-automation
 * platform pioneered around the meeting-link-and-availability
 * data model (founded by Tope Awotona in 2013 in Atlanta;
 * raised $350M+ across rounds led by OpenView Venture Partners
 * and Iconiq Capital at a peak $3B valuation in 2021; ships a
 * freemium B2C scheduling-link product + a B2B Calendly-for-
 * Teams enterprise-scheduling platform across the productivity-
 * software segment — alongside competitors Doodle, Cal.com,
 * Acuity Scheduling, Microsoft Bookings, and Google Appointment
 * Schedules — with a hybrid distributed workforce concentrated
 * in Atlanta and Remote US) — publishes its consolidated
 * careers board through Greenhouse at the bare slug `calendly`
 * (the lowercase brand name; case-symmetric with the wire
 * `company_name === 'Calendly'`; see Spec 080 § 10 D-05). The
 * wire `company_name` is the literal single-token bare-brand
 * string `'Calendly'` byte-for-byte (8 bytes; case-symmetric
 * with the lowercase slug).
 *
 * **One structural deviation from the Bitwarden (Spec 079)
 * template** — D-04 wire-shape variant 2 (canonical Greenhouse
 * host; Calendly returns to baseline shape after Bitwarden's
 * variant-18 first-cohort observation). All other axes share
 * with Bitwarden: D-08 entity-decode-then-tag-strip, D-09
 * omitted with case-symmetric bare-brand wire, D-10 applied
 * (Calendly 1/20 padded ~5.0 %; Bitwarden 1/11 padded ~9.1 %
 * — Calendly's posting hygiene slightly cleaner), D-11 fully-
 * clean department pass-through.
 *
 *   1. **D-04 — wire-shape variant 2 (canonical Greenhouse
 *      host).** Calendly's tenant publishes its `absolute_url`
 *      on the canonical Greenhouse variant-2 shape
 *      `https://job-boards.greenhouse.io/calendly/jobs/<id>` —
 *      the baseline shape used by the majority of cohort
 *      plugins from Klaviyo onwards. Calendly **returns to
 *      baseline** after Bitwarden's first-cohort variant-18
 *      observation in Spec 079. No new variant introduced.
 *
 *      The plugin emits `listing.absolute_url` byte-for-byte;
 *      the **fallback** `jobUrl` constructor (when Greenhouse
 *      omits `absolute_url`) reconstructs the same canonical
 *      variant-2 form `https://job-boards.greenhouse.io/calendly/jobs/<id>`
 *      (deterministic given the listing ID — no defence-in-
 *      depth divergence between wire and fallback, distinct
 *      from Bitwarden's variant-18 wire form vs variant-2
 *      fallback split).
 *
 * Shared with Bitwarden:
 *
 *   - **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     Like every plugin from Klaviyo onwards, Calendly's
 *     `content` is HTML-entity-encoded (`&lt;div class=&quot;
 *     content-intro&quot;&gt;&lt;h4&gt;&lt;strong&gt;What's in
 *     it for you?&amp;nbsp;&lt;/strong&gt;&lt;/h4&gt;`), so
 *     the plugin decodes entities BEFORE stripping tags.
 *     **Thirty-sixth** plugin in the cohort to apply D-08.
 *
 *   - **D-09 — brand-name trim omitted (case-symmetric).** Wire
 *     `company_name === 'Calendly'` byte-for-byte (the single-
 *     token bare brand name; case-symmetric with the lowercase
 *     slug `calendly` — same shape as Bitwarden `'Bitwarden'` /
 *     Udemy `'Udemy'` / Carta `'Carta'` / Lattice `'Lattice'`);
 *     no legal-entity suffix on the wire — distinct from the
 *     legal-entity name "Calendly LLC" that may appear in
 *     corporate filings. The plugin reads `listing.company_name`
 *     directly with `'Calendly'` as a defensive fallback.
 *     **Thirtieth cohort plugin to omit D-09**, returning to
 *     the case-symmetric bare-brand wire form (after the seven
 *     slug/wire asymmetry cases — Ramp Network, Scale AI,
 *     fuboTV, Honeycomb, MasterClass, Maven Clinic, and Stitch
 *     Fix).
 *
 *   - **D-10 — wire-title `.trim()` applied.** 1 of 20 wire titles
 *     in the run-290 probe carries trailing ASCII-space padding
 *     (`'Sr. Director, Engineering '` — single-trailing-space-
 *     padded; ~5.0 % pad rate; lower than Bitwarden's 9.1 %
 *     rate — slightly cleaner posting hygiene). The plugin
 *     applies `.trim()` to the wire `title` before downstream
 *     filters and emit. **Nineteenth cohort plugin to apply
 *     D-10** (after Brex, Buildkite, ZoomInfo, Attentive,
 *     Elastic, Intercom, Mixpanel, Faire, Carta, ClassPass,
 *     Epic Games, Flexport, fuboTV, Glossier, Honeycomb,
 *     Maven Clinic, Stitch Fix, Udemy, and Bitwarden).
 *
 *   - **D-11 — fully-clean department pass-through.** Calendly's
 *     wire department names are 0 of 20 padded (0 % pad rate —
 *     `'Marketing'`, `'Engineering'`, `'Product'`, `'Customer
 *     Experience'`, `'Security'` — clean single-token and
 *     multi-token forms). The plugin emits the wire
 *     `departments[0].name` byte-for-byte without a `.trim()`
 *     (the pass-through is a no-op on the clean wire data; if
 *     Calendly adds padding upstream in the future, the pass-
 *     through observability lock catches the diff in the unit
 *     tests).
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/calendly/jobs';

@SourcePlugin({
  site: Site.CALENDLY,
  name: 'Calendly',
  category: 'company',
})
@Injectable()
export class CalendlyService implements IScraper {
  private readonly logger = new Logger(CalendlyService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Calendly: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10: trim wire title (handles BOTH leading and trailing
        // pad bytes — 1 of 20 wire titles in run-290 probe carries
        // single-trailing-space padding).
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
        const id = `calendly-${jobId}`;

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
            site: Site.CALENDLY,
            title,
            // D-09 omitted: case-symmetric bare-brand wire
            // `company_name === 'Calendly'` byte-for-byte (8 bytes;
            // case-symmetric with the lowercase slug); pass-through
            // with a defensive `'Calendly'` fallback.
            companyName: listing.company_name ?? 'Calendly',
            // D-04: wire `absolute_url` flows through to `jobUrl`
            // byte-for-byte (preserving the canonical variant-2
            // shape `job-boards.greenhouse.io/calendly/jobs/<id>`).
            // Fallback reconstructs the same canonical variant-2
            // form (deterministic given the listing ID — no
            // defence-in-depth divergence between wire and
            // fallback, distinct from Bitwarden's variant-18 wire
            // vs variant-2 fallback split).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/calendly/jobs/${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            // D-11: byte-for-byte pass-through of the wire
            // department name; the wire is fully clean (0 of 20
            // padded in run #290 probe) so this is a no-op pass-
            // through.
            department: listing.departments?.[0]?.name ?? null,
          }),
        );
      }

      this.logger.log(`Calendly: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Calendly scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
