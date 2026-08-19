import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Udemy, Inc. — operator of the dominant marketplace-driven
 * online-learning platform pioneered around the user-generated-
 * course longitudinal-skills-acceleration data model (founded by
 * Eren Bali, Oktay Caglar, and Gagan Biyani in 2010 in Ankara/
 * San Francisco; IPO'd on NASDAQ as `UDMY` in October 2021 at a
 * $4B valuation; ships a hybrid B2C course-marketplace + B2B
 * Udemy Business enterprise-skill-platform product across the
 * lifelong-learning segment — alongside competitors Coursera,
 * MasterClass, Skillshare, Pluralsight, LinkedIn Learning, and
 * Domestika — with a hybrid in-office / remote workforce
 * concentrated across the United States, Turkey, Ireland, and
 * India) — publishes its consolidated careers board through
 * Greenhouse at the bare slug `udemy` (the lowercase brand name;
 * case-symmetric with the wire `company_name === 'Udemy'`; see
 * Spec 078 § 10 D-05). The wire `company_name` is the literal
 * single-token bare-brand string `'Udemy'` byte-for-byte (5
 * bytes; case-symmetric with the lowercase slug).
 *
 * **One structural deviation from the Carta (Spec 066) template**
 * — D-04 wire-shape variant 17 (first cohort plugin to use
 * variant 17; first cohort observation of a third-party SaaS
 * career-board host (CareerPuck); distinct from Carta's variant
 * 2 modern hosted-board apex shape). All other axes share with
 * Carta: D-08 entity-decode-then-tag-strip, D-09 omitted with
 * case-symmetric bare-brand wire, D-10 applied (Udemy 2/17
 * padded; Carta 1/10 padded — near-identical pad rate ~11.8 %
 * vs ~10 %), D-11 fully-clean department pass-through.
 *
 *   1. **D-04 — wire-shape variant 17 (third-party-SaaS-host,
 *      CareerPuck).** Udemy's tenant publishes its
 *      `absolute_url` on a **previously-unobserved third-party-
 *      SaaS-host shape**
 *      `https://app.careerpuck.com/job-board/udemy/job/<id>?gh_jid=<id>`
 *      (`app.careerpuck.com` — the third-party CareerPuck SaaS
 *      host proxying Greenhouse boards through its job-board
 *      front-end, distinct from every prior cohort variant
 *      which all use either Greenhouse-owned hosts
 *      (`boards.greenhouse.io`, `job-boards.greenhouse.io`) or
 *      the brand's own domain (bare, `www.`-prefixed, vanity-
 *      subdomain, or parent-domain — variants 10..16);
 *      `/job-board/udemy/` path with the slug embedded;
 *      singular `/job/<id>` path with the listing ID; single
 *      `gh_jid` query parameter — same single-query-parameter
 *      shape as variants 10, 12, 13, 14, 15). This is the
 *      **first** plugin in the cohort to use **wire-shape
 *      variant 17** — the **twentieth distinct wire-shape
 *      variant** in the company-direct cohort and the **first**
 *      to publish through a third-party SaaS career-board host
 *      (CareerPuck) rather than a brand-owned domain or a
 *      Greenhouse-owned host.
 *
 *      The plugin emits `listing.absolute_url` byte-for-byte to
 *      preserve the canonical destination. The **fallback**
 *      `jobUrl` constructor (when Greenhouse omits
 *      `absolute_url` — a defence-in-depth path Greenhouse has
 *      not exercised against this tenant in the audit window)
 *      defaults to the canonical Greenhouse **variant-2** form
 *      `https://job-boards.greenhouse.io/udemy/jobs/<id>` rather
 *      than reconstructing the third-party-SaaS-host shape,
 *      because the bare CareerPuck shape requires
 *      `app.careerpuck.com`-side proxying that may not be
 *      guaranteed for all listing IDs (same fallback strategy
 *      as ClassPass — Spec 067 § 10 D-04 — Epic Games — Spec
 *      069 § 10 D-04 — fuboTV — Spec 071 § 10 D-04 — Lattice
 *      — Spec 074 § 10 D-04 — and Stitch Fix — Spec 077 § 10
 *      D-04).
 *
 * Shared with Carta:
 *
 *   - **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     Like every plugin from Klaviyo onwards, Udemy's `content`
 *     is HTML-entity-encoded (`&lt;div class=&quot;content-intro&quot;&gt;
 *     &lt;h3&gt;&lt;strong&gt;Join Udemy. Help &lt;/strong&gt;&lt;strong&gt;define&lt;em&gt;
 *     &lt;/em&gt;&lt;/strong&gt;&lt;strong&gt;the future of learning.&lt;/strong&gt;&lt;/h3&gt;
 *     &lt;p&gt;Udemy is an AI-powered skills acceleration platform...`),
 *     so the plugin decodes entities BEFORE stripping tags.
 *     **Thirty-fourth** plugin in the cohort to apply D-08.
 *
 *   - **D-09 — brand-name trim omitted (case-symmetric).** Wire
 *     `company_name === 'Udemy'` byte-for-byte (the single-
 *     token bare brand name; case-symmetric with the lowercase
 *     slug `udemy` — same shape as Cameo `'Cameo'` / Carta
 *     `'Carta'` / Lattice `'Lattice'`); no legal-entity suffix
 *     on the wire — distinct from the legal-entity name "Udemy,
 *     Inc." that appears in current SEC filings under NASDAQ
 *     ticker `UDMY`. The plugin reads `listing.company_name`
 *     directly with `'Udemy'` as a defensive fallback. **Twenty-
 *     eighth cohort plugin to omit D-09**, returning to the
 *     case-symmetric bare-brand wire form (after the seven slug/
 *     wire asymmetry cases — Ramp Network, Scale AI, fuboTV,
 *     Honeycomb, MasterClass, Maven Clinic, and Stitch Fix).
 *
 *   - **D-10 — wire-title `.trim()` applied.** 2 of 17 wire titles
 *     in the run-288 probe carry trailing ASCII-space padding
 *     (`'Join Our Talent Community '`, `'Sales Development
 *     Representative '` — both single-trailing-space-padded;
 *     ~11.8 % pad rate). The plugin applies `.trim()` to the
 *     wire `title` before downstream filters and emit.
 *     **Seventeenth cohort plugin to apply D-10** (after Brex,
 *     Buildkite, ZoomInfo, Attentive, Elastic, Intercom,
 *     Mixpanel, Faire, Carta, ClassPass, Epic Games, Flexport,
 *     fuboTV, Glossier, Honeycomb, Maven Clinic, and Stitch
 *     Fix).
 *
 *   - **D-11 — fully-clean department pass-through.** Udemy's
 *     wire department names are 0 of 16 populated padded (0 %
 *     pad rate — `'UB Sales - ADR'`, `'Sales'`, `'Consumer
 *     Partnerships'`, `'Product Design and UXR'`, `'UB Sales -
 *     Enterprise'`, `'Product Management'`, `'Engineering'`,
 *     etc. — clean single-token and multi-token forms with
 *     internal whitespace, hyphens, and ampersands). One
 *     listing has an empty `departments` array — the plugin's
 *     `?.[0]?.name` optional-chain emits `null` for that
 *     listing. The plugin emits the wire `departments[0].name`
 *     byte-for-byte without a `.trim()` (the pass-through is a
 *     no-op on the clean wire data; if Udemy adds padding
 *     upstream in the future, the pass-through observability
 *     lock catches the diff in the unit tests).
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/udemy/jobs';

@SourcePlugin({
  site: Site.UDEMY,
  name: 'Udemy',
  category: 'company',
})
@Injectable()
export class UdemyService implements IScraper {
  private readonly logger = new Logger(UdemyService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Udemy: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10: trim wire title (handles BOTH leading and trailing
        // pad bytes — 2 of 17 wire titles in run-288 probe carry
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
        const id = `udemy-${jobId}`;

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
            site: Site.UDEMY,
            title,
            // D-09 omitted: case-symmetric bare-brand wire
            // `company_name === 'Udemy'` byte-for-byte (5 bytes;
            // case-symmetric with the lowercase slug); pass-
            // through with a defensive `'Udemy'` fallback.
            companyName: listing.company_name ?? 'Udemy',
            // D-04: wire `absolute_url` flows through to `jobUrl`
            // byte-for-byte (preserving the variant-17 third-
            // party-SaaS-host shape
            // `app.careerpuck.com/job-board/udemy/job/<id>?gh_jid=<id>`).
            // Fallback uses canonical Greenhouse variant-2 form
            // `job-boards.greenhouse.io/<slug>/jobs/<id>` rather
            // than reconstructing the third-party-SaaS-host
            // shape, because the fallback can only produce a
            // guaranteed-resolvable URL using the Greenhouse
            // subdomain.
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/udemy/jobs/${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            // D-11: byte-for-byte pass-through of the wire
            // department name; the wire is fully clean (0 of 16
            // populated padded in run #288 probe) so this is a
            // no-op pass-through.
            department: listing.departments?.[0]?.name ?? null,
          }),
        );
      }

      this.logger.log(`Udemy: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Udemy scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
