import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Bitwarden, Inc. — operator of the dominant open-source-friendly
 * identity-security and password-management platform pioneered
 * around the cross-platform end-to-end-encrypted credential vault
 * data model (founded by Kyle Spearrin in 2015 in Santa Barbara;
 * raised $112M+ across rounds led by PSG and Battery Ventures at
 * a peak $1.5B valuation in 2024; ships a freemium B2C password-
 * manager + B2B Bitwarden-for-Business enterprise-credential-
 * platform product across the identity-security segment —
 * alongside competitors 1Password, Dashlane, LastPass, NordPass,
 * and Keeper Security — with a fully-distributed remote-first
 * workforce concentrated across the United States and Europe) —
 * publishes its consolidated careers board through Greenhouse at
 * the bare slug `bitwarden` (the lowercase brand name; case-
 * symmetric with the wire `company_name === 'Bitwarden'`; see
 * Spec 079 § 10 D-05). The wire `company_name` is the literal
 * single-token bare-brand string `'Bitwarden'` byte-for-byte (9
 * bytes; case-symmetric with the lowercase slug).
 *
 * **One structural deviation from the Udemy (Spec 078) template**
 * — D-04 wire-shape variant 18 (first cohort plugin to use
 * variant 18; distinct from Udemy's variant 17 third-party-SaaS-
 * host shape — Bitwarden uses a brand-owned domain rather than a
 * third-party SaaS host). All other axes share with Udemy: D-08
 * entity-decode-then-tag-strip, D-09 omitted with case-symmetric
 * bare-brand wire, D-10 applied (Bitwarden 1/11 padded; Udemy
 * 2/17 padded — near-identical pad rate ~9.1 % vs ~11.8 %),
 * D-11 fully-clean department pass-through.
 *
 *   1. **D-04 — wire-shape variant 18 (bare brand-domain
 *      `/careers/<id>/`-trailing-slash query-with-id).**
 *      Bitwarden's tenant publishes its `absolute_url` on a
 *      **previously-unobserved bare brand-domain shape**
 *      `https://bitwarden.com/careers/<id>/?gh_jid=<id>` (bare
 *      `bitwarden.com` brand-domain — no `www.` prefix, like
 *      variant 13's `epicgames.com` and variant 15's
 *      `lattice.com`; `/careers/<id>/` path with the listing ID
 *      embedded — distinct from variant 13's
 *      `careers/jobs/<id>?gh_jid=<id>` shape which has a
 *      `/jobs/` segment between `/careers` and the ID;
 *      **trailing slash on the path** before the query —
 *      distinct from every prior cohort variant which all omit
 *      the trailing slash before `?gh_jid=`; single `gh_jid`
 *      query parameter — same single-query-parameter shape as
 *      variants 10, 12, 13, 14, 15, 17). This is the **first**
 *      plugin in the cohort to use **wire-shape variant 18** —
 *      the **twenty-first distinct wire-shape variant** in the
 *      company-direct cohort.
 *
 *      The plugin emits `listing.absolute_url` byte-for-byte to
 *      preserve the canonical destination (including the
 *      trailing slash before `?gh_jid=`). The **fallback**
 *      `jobUrl` constructor (when Greenhouse omits
 *      `absolute_url` — a defence-in-depth path Greenhouse has
 *      not exercised against this tenant in the audit window)
 *      defaults to the canonical Greenhouse **variant-2** form
 *      `https://job-boards.greenhouse.io/bitwarden/jobs/<id>`
 *      rather than reconstructing the bare-domain trailing-
 *      slash shape, because the bare-domain shape requires
 *      `bitwarden.com`-side proxying that may not be guaranteed
 *      for all listing IDs (same fallback strategy as ClassPass
 *      — Spec 067 § 10 D-04 — Epic Games — Spec 069 § 10 D-04
 *      — fuboTV — Spec 071 § 10 D-04 — Lattice — Spec 074 § 10
 *      D-04 — Stitch Fix — Spec 077 § 10 D-04 — and Udemy —
 *      Spec 078 § 10 D-04).
 *
 * Shared with Udemy:
 *
 *   - **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     Like every plugin from Klaviyo onwards, Bitwarden's
 *     `content` is HTML-entity-encoded (`&lt;p&gt;Bitwarden is the
 *     trusted identity security leader for millions of users
 *     worldwide, empowering enterprises, developers, and
 *     individuals to securely manage and share sensitive
 *     information anywhere...`), so the plugin decodes entities
 *     BEFORE stripping tags. **Thirty-fifth** plugin in the
 *     cohort to apply D-08.
 *
 *   - **D-09 — brand-name trim omitted (case-symmetric).** Wire
 *     `company_name === 'Bitwarden'` byte-for-byte (the single-
 *     token bare brand name; case-symmetric with the lowercase
 *     slug `bitwarden` — same shape as Udemy `'Udemy'` / Carta
 *     `'Carta'` / Lattice `'Lattice'`); no legal-entity suffix
 *     on the wire — distinct from the legal-entity name
 *     "Bitwarden, Inc." that may appear in corporate filings.
 *     The plugin reads `listing.company_name` directly with
 *     `'Bitwarden'` as a defensive fallback. **Twenty-ninth
 *     cohort plugin to omit D-09**, returning to the case-
 *     symmetric bare-brand wire form (after the seven slug/
 *     wire asymmetry cases — Ramp Network, Scale AI, fuboTV,
 *     Honeycomb, MasterClass, Maven Clinic, and Stitch Fix).
 *
 *   - **D-10 — wire-title `.trim()` applied.** 1 of 11 wire titles
 *     in the run-289 probe carries trailing ASCII-space padding
 *     (`'Senior Full Stack Software Engineer '` — single-
 *     trailing-space-padded; ~9.1 % pad rate). The plugin
 *     applies `.trim()` to the wire `title` before downstream
 *     filters and emit. **Eighteenth cohort plugin to apply
 *     D-10** (after Brex, Buildkite, ZoomInfo, Attentive,
 *     Elastic, Intercom, Mixpanel, Faire, Carta, ClassPass,
 *     Epic Games, Flexport, fuboTV, Glossier, Honeycomb, Maven
 *     Clinic, Stitch Fix, and Udemy).
 *
 *   - **D-11 — fully-clean department pass-through.** Bitwarden's
 *     wire department names are 0 of 11 padded (0 % pad rate —
 *     `'Engineering'`, `'Sales'`, `'Customer Success'`,
 *     `'Product'` — clean single-token and multi-token forms).
 *     The plugin emits the wire `departments[0].name` byte-for-
 *     byte without a `.trim()` (the pass-through is a no-op on
 *     the clean wire data; if Bitwarden adds padding upstream
 *     in the future, the pass-through observability lock
 *     catches the diff in the unit tests).
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/bitwarden/jobs';

@SourcePlugin({
  site: Site.BITWARDEN,
  name: 'Bitwarden',
  category: 'company',
})
@Injectable()
export class BitwardenService implements IScraper {
  private readonly logger = new Logger(BitwardenService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Bitwarden: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10: trim wire title (handles BOTH leading and trailing
        // pad bytes — 1 of 11 wire titles in run-289 probe carries
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
        const id = `bitwarden-${jobId}`;

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
            site: Site.BITWARDEN,
            title,
            // D-09 omitted: case-symmetric bare-brand wire
            // `company_name === 'Bitwarden'` byte-for-byte (9 bytes;
            // case-symmetric with the lowercase slug); pass-
            // through with a defensive `'Bitwarden'` fallback.
            companyName: listing.company_name ?? 'Bitwarden',
            // D-04: wire `absolute_url` flows through to `jobUrl`
            // byte-for-byte (preserving the variant-18 bare brand-
            // domain trailing-slash shape
            // `bitwarden.com/careers/<id>/?gh_jid=<id>`). Fallback
            // uses canonical Greenhouse variant-2 form
            // `job-boards.greenhouse.io/<slug>/jobs/<id>` rather
            // than reconstructing the bare-domain trailing-slash
            // shape, because the fallback can only produce a
            // guaranteed-resolvable URL using the Greenhouse
            // subdomain.
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/bitwarden/jobs/${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            // D-11: byte-for-byte pass-through of the wire
            // department name; the wire is fully clean (0 of 11
            // padded in run #289 probe) so this is a no-op pass-
            // through.
            department: listing.departments?.[0]?.name ?? null,
          }),
        );
      }

      this.logger.log(`Bitwarden: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Bitwarden scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
