import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * ClassPass — operator of the dominant subscription-fitness-aggregator
 * platform (founded by Payal Kadakia in 2013 in New York City; acquired
 * by Mindbody in 2021 to form a unified wellness/fitness marketplace;
 * the subscription-fitness-aggregator surface that anchors the
 * boutique-fitness category) — publishes its consolidated careers
 * board through Greenhouse at the bare slug `classpass` (the
 * lowercase brand name; no whitespace transform required since the
 * brand is a single word; see Spec 067 § 10 D-05). The wire
 * `company_name` is the single-token bare brand `'ClassPass'` (with
 * internal capital P) byte-for-byte.
 *
 * One structural deviation from the Carta (Spec 066) template:
 *
 *   1. **D-04 wire-shape variant 12 (vanity-domain).** Carta publishes
 *      `absolute_url` on **wire-shape variant 2** — the modern
 *      US-region permalink subdomain
 *      `https://job-boards.greenhouse.io/carta/jobs/<id>` shape.
 *      ClassPass publishes on a previously-unobserved **wire-shape
 *      variant 12** — the vanity-domain shape
 *      `https://www.playlist.com/careers/opportunities/<id>?gh_jid=<id>`
 *      (parent-domain `www.playlist.com` rather than ClassPass's own
 *      `classpass.com`; `careers/opportunities` path; single
 *      `gh_jid` query parameter — distinct from Elastic's variant-11
 *      duplicate-`gh_jid` shape). This is the **first** plugin in the
 *      cohort to use wire-shape variant 12 — the **fifteenth distinct
 *      wire-shape variant** in the company-direct cohort.
 *
 *      The plugin emits `listing.absolute_url` byte-for-byte to
 *      preserve the canonical destination. The **fallback** `jobUrl`
 *      constructor (when Greenhouse omits `absolute_url` — a
 *      defence-in-depth path Greenhouse has not exercised against
 *      this tenant in the audit window) defaults to the canonical
 *      Greenhouse **variant-2** form
 *      `https://job-boards.greenhouse.io/classpass/jobs/<id>` rather
 *      than reconstructing the vanity-domain shape, because the
 *      vanity-domain shape requires `playlist.com`-side proxying
 *      that may not be guaranteed for all listing IDs.
 *
 * Shared with Carta:
 *
 *   - **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     Like every plugin from Klaviyo onwards, ClassPass's `content`
 *     is HTML-entity-encoded (`&lt;div class=&quot;content-intro&quot;&gt;
 *     &lt;p&gt;At Playlist, life&#39;s rich...`), so the plugin
 *     decodes entities BEFORE stripping tags. **Twenty-third** plugin
 *     in the cohort to apply D-08.
 *
 *   - **D-09 — brand-name trim omitted.** Wire `company_name === 'ClassPass'`
 *     byte-for-byte (the single-token bare brand name with internal
 *     capital P; no parent-company suffix); the plugin reads
 *     `listing.company_name` directly with `'ClassPass'` as a
 *     defensive fallback. **Seventeenth cohort plugin to omit D-09**,
 *     returning to the single-word bare-brand wire form.
 *
 *   - **D-10 — wire-title `.trim()` applied.** At least 10 of 70 wire
 *     titles in the run-277 probe carry trailing ASCII-space padding
 *     (`'Director, Product Management, ClassPass Consumer '`,
 *     `'Engineering Manager - Consumer & Merchandising '`, etc.).
 *     The plugin applies `.trim()` to the wire `title` before
 *     downstream filters and emit. **Tenth cohort plugin to apply
 *     D-10** (after Brex, Buildkite, ZoomInfo, Attentive, Elastic,
 *     Intercom, Mixpanel, Faire, and Carta).
 *
 *   - **D-11 — fully-clean department pass-through.** ClassPass's
 *     wire department names are 0 of 70 padded (0 % pad rate). The
 *     plugin emits the wire `departments[0].name` byte-for-byte
 *     without a `.trim()` (the pass-through is a no-op on the clean
 *     wire data; if ClassPass adds padding upstream in the future,
 *     the pass-through observability lock catches the diff in the
 *     unit tests).
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/classpass/jobs';

@SourcePlugin({
  site: Site.CLASSPASS,
  name: 'ClassPass',
  category: 'company',
})
@Injectable()
export class ClasspassService implements IScraper {
  private readonly logger = new Logger(ClasspassService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`ClassPass: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10: trim wire title before downstream filters and emit.
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
        const id = `classpass-${jobId}`;

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
            site: Site.CLASSPASS,
            title,
            companyName: listing.company_name ?? 'ClassPass',
            // D-04: wire `absolute_url` flows through to `jobUrl`
            // byte-for-byte (preserving the variant-12 vanity-domain
            // shape `playlist.com/careers/opportunities/<id>?gh_jid=<id>`).
            // Fallback uses canonical Greenhouse variant-2 form
            // `job-boards.greenhouse.io/<slug>/jobs/<id>` rather than
            // reconstructing the vanity-domain shape, because the
            // fallback can only produce a guaranteed-resolvable URL
            // using the Greenhouse subdomain.
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/classpass/jobs/${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            // D-11: byte-for-byte pass-through of the wire department
            // name; the wire is fully clean (0 of 70 padded in run
            // #277 probe) so this is a no-op pass-through.
            department: listing.departments?.[0]?.name ?? null,
          }),
        );
      }

      this.logger.log(`ClassPass: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`ClassPass scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
