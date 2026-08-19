import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Maven Clinic, Inc. — operator of the dominant virtual women's-
 * and-family-health clinic platform pioneered around the digital-
 * first maternity / fertility / parenting longitudinal-care data
 * model (founded by Kate Ryder in 2014 in New York City; raised
 * $300M+ across rounds led by General Catalyst, Sequoia Capital,
 * Oak HC/FT, Dragoneer Investment Group, and Lux Capital at a
 * peak $1.35B valuation in 2022 — the first women's-and-family-
 * health unicorn in the United States; ships an employer-and-
 * payor-funded virtual-care product across maternity, fertility,
 * menopause, parenting, and pediatric segments — alongside
 * competitors Progyny, Carrot Fertility, Kindbody, Tia, and
 * Origin — with a hybrid in-office / remote workforce
 * concentrated across the United States) — publishes its
 * consolidated careers board through Greenhouse at the bare slug
 * `mavenclinic` (the lowercase concatenated two-word brand,
 * case-asymmetric AND length-asymmetric with the wire
 * `company_name === 'Maven Clinic'` which carries the brand's
 * two-word internal-whitespace form; see Spec 076 § 10 D-05).
 * The wire `company_name` is the literal two-word brand string
 * `'Maven Clinic'` byte-for-byte (12 bytes; slug `mavenclinic`
 * is 11 bytes — slug/wire-asymmetric, wire LONGER than slug by
 * 1 byte (the internal ASCII space at index 5 between `Maven`
 * and `Clinic`)).
 *
 * **One structural deviation from the Honeycomb (Spec 073)
 * template** — D-09 omitted with **internal-whitespace wire
 * asymmetry** (the wire `company_name` carries an internal
 * ASCII space at byte index 5 separating `Maven` from
 * `Clinic`; the **second** internal-whitespace asymmetry case
 * in the cohort after Scale AI's slug `scaleai` / wire `'Scale
 * AI'`; the **sixth** slug/wire asymmetry case overall after
 * Ramp Network, Scale AI, fuboTV, Honeycomb, and MasterClass).
 *
 * Shared with Honeycomb:
 *
 *   - **D-04 — wire-shape variant 2 fallback URL.** Maven
 *     Clinic's tenant publishes its `absolute_url` on the modern
 *     `https://job-boards.greenhouse.io/mavenclinic/jobs/<id>` shape
 *     — the **seventeenth** plugin in the cohort to use variant 2
 *     (after Vercel, Affirm, Gusto, Mercury, Buildkite, Netlify,
 *     Postman, Webflow, Attentive, Intercom, Mixpanel, Scale AI,
 *     Cameo, Carta, Honeycomb, and MasterClass). The fallback
 *     `jobUrl` constructor mirrors this byte-for-byte.
 *
 *   - **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     Like every plugin from Klaviyo onwards, Maven Clinic's
 *     `content` is HTML-entity-encoded (`&lt;div class=&quot;content-intro&quot;&gt;
 *     &lt;p&gt;Maven is the world&#39;s largest virtual clinic for
 *     women and families...`), so the plugin decodes entities BEFORE
 *     stripping tags. **Thirty-second** plugin in the cohort to
 *     apply D-08.
 *
 *   - **D-09 — brand-name trim omitted (with internal-whitespace
 *     asymmetry).** Wire `company_name === 'Maven Clinic'`
 *     byte-for-byte (the two-word brand name with single internal
 *     ASCII space at byte index 5; no legal-entity suffix on the
 *     wire — distinct from the legal-entity name "Maven Clinic,
 *     Inc." that may appear in corporate filings). The plugin
 *     reads `listing.company_name` directly with `'Maven Clinic'`
 *     as a defensive fallback. **Twenty-sixth cohort plugin to
 *     omit D-09**, but the **sixth** slug/wire asymmetry case in
 *     the cohort (after Ramp Network slug `rampnetwork` / wire
 *     `'Ramp'`, Scale AI slug `scaleai` / wire `'Scale AI'`,
 *     fuboTV slug `fubotv` / wire `'Fubo'`, Honeycomb slug
 *     `honeycomb` / wire `'Honeycomb.io'`, and MasterClass slug
 *     `masterclass` / wire `'MasterClass'`) — and the **second**
 *     internal-whitespace asymmetry case in the cohort after
 *     Scale AI (same +1 byte differential, same single-internal-
 *     space delta).
 *
 *   - **D-10 — wire-title `.trim()` applied.** At least 3 of 24
 *     wire titles in the run-286 probe carry trailing ASCII-space
 *     padding (`'Clinical Outcomes Analyst '`, `'Director,
 *     Employer Sales '`, `'Manager, Member Services '` — all
 *     single-trailing-space-padded; ~12.5 % pad rate). The plugin
 *     applies `.trim()` to the wire `title` before downstream
 *     filters and emit. **Fifteenth cohort plugin to apply D-10**
 *     (after Brex, Buildkite, ZoomInfo, Attentive, Elastic,
 *     Intercom, Mixpanel, Faire, Carta, ClassPass, Epic Games,
 *     Flexport, fuboTV, Glossier, and Honeycomb).
 *
 *   - **D-11 — fully-clean department pass-through.** Maven
 *     Clinic's wire department names are 0 of 24 padded (0 % pad
 *     rate — `'Brand & Communications'`, `'Clinical Outcomes'`,
 *     `'Employer Sales'`, `'Member Services'`, `'Engineering'`).
 *     The plugin emits the wire `departments[0].name` byte-for-byte
 *     without a `.trim()` (the pass-through is a no-op on the
 *     clean wire data; if Maven Clinic adds padding upstream in
 *     the future, the pass-through observability lock catches the
 *     diff in the unit tests).
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/mavenclinic/jobs';

@SourcePlugin({
  site: Site.MAVENCLINIC,
  name: 'Maven Clinic',
  category: 'company',
})
@Injectable()
export class MavenclinicService implements IScraper {
  private readonly logger = new Logger(MavenclinicService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Maven Clinic: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10: trim wire title (handles BOTH leading and trailing
        // pad bytes — 3 of 24 wire titles in run-286 probe carry
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
        const id = `mavenclinic-${jobId}`;

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
            site: Site.MAVENCLINIC,
            title,
            // D-09 omitted: internal-whitespace-asymmetric wire
            // `company_name` is `'Maven Clinic'` byte-for-byte
            // (12 bytes; 1 byte longer than slug `mavenclinic`
            // via the internal ASCII space at index 5);
            // pass-through with a defensive `'Maven Clinic'`
            // fallback locks the slug/wire internal-whitespace
            // asymmetry observable.
            companyName: listing.company_name ?? 'Maven Clinic',
            // D-04: variant-2 modern hosted-board fallback —
            // `job-boards.greenhouse.io/<slug>/jobs/<id>`.
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/mavenclinic/jobs/${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            // D-11: byte-for-byte pass-through of the wire department
            // name; the wire is fully clean (0 of 24 padded in run
            // #286 probe) so this is a no-op pass-through.
            department: listing.departments?.[0]?.name ?? null,
          }),
        );
      }

      this.logger.log(`Maven Clinic: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Maven Clinic scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
