import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Lookout, Inc. — operator of the mobile-endpoint security
 * pipeline pioneered around the cloud-delivered phishing-and-
 * content-protection (PCP) longitudinal-telemetry data model
 * (founded by John Hering, Kevin Mahaffey, and James Burgess in
 * 2007 in San Francisco, CA; raised $400M+ across rounds led by
 * Andreessen Horowitz, Khosla Ventures, Greylock Partners, Index
 * Ventures, and Accel Partners; ships a unified mobile-endpoint
 * detection-and-response (Mobile EDR) + zero-trust secure-access
 * (ZTNA / SSE) platform across the cybersecurity segment —
 * alongside competitors Zimperium, Wandera, MobileIron, Proofpoint,
 * and Cisco Umbrella — with a hybrid distributed workforce
 * concentrated across San Francisco, Boston, Reston VA, Toronto,
 * and Remote across the United States, Canada, and Europe) —
 * publishes its consolidated careers board through Greenhouse at
 * the bare slug `lookout` (the lowercase brand name; case-
 * symmetric with the wire `company_name === 'Lookout'`; see Spec
 * 083 § 10 D-05). The wire `company_name` is the clean 7-byte
 * `'Lookout'` form across 100 % of run-293 wire listings (6 of
 * 6) — no leading or trailing pad bytes. The plugin reads
 * `listing.company_name` directly with `'Lookout'` as a
 * defensive fallback; the emitted `companyName` is byte-for-byte
 * equal to the wire form.
 *
 * **One structural deviation from the Fivetran (Spec 082)
 * template:**
 *
 *   1. **D-04 — wire-shape variant 20 (`www.`-prefixed brand-
 *      domain singular `/careers/job-post` query-only-id).**
 *      Lookout publishes its `absolute_url` on a **previously-
 *      unobserved** shape
 *      `https://www.lookout.com/careers/job-post?gh_jid=<id>`
 *      (`www.lookout.com` — `www.`-prefixed brand-domain, same
 *      `www.` prefix as variants 16 and 19; `/careers/job-post`
 *      SINGULAR path with `-post` suffix — distinct from variant
 *      13's `careers/jobs/<id>?gh_jid=<id>` plural-with-id-in-
 *      path, variant 16's `www.stitchfix.com/careers/jobs?gh_jid=<id>&gh_jid=<id>`
 *      plural-with-duplicate-query, variant 18's
 *      `bitwarden.com/careers/<id>/?gh_jid=<id>` `<id>`-in-path-
 *      with-trailing-slash-and-query, AND variant 19's
 *      `www.fivetran.com/careers/job?gh_jid=<id>` singular-`/job`
 *      without `-post` suffix; single `gh_jid` query parameter —
 *      same single-query shape as variants 10, 12, 13, 14, 15,
 *      17, 18, 19). **First** plugin in the cohort to use
 *      **wire-shape variant 20** — the **twenty-third distinct
 *      wire-shape variant** in the company-direct cohort.
 *
 *      The plugin emits `listing.absolute_url` byte-for-byte.
 *      The **fallback** `jobUrl` constructor defaults to the
 *      canonical Greenhouse **variant-2** form
 *      `https://job-boards.greenhouse.io/lookout/jobs/<id>`
 *      rather than reconstructing the `www.`-prefixed bare-
 *      domain shape (same fallback strategy as ClassPass / Epic
 *      Games / fuboTV / Lattice / Stitch Fix / Udemy / Bitwarden
 *      / Fivetran).
 *
 * Shared with Fivetran:
 *
 *   - **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     Like every plugin from Klaviyo onwards, Lookout's `content`
 *     is HTML-entity-encoded (`&lt;div class=&quot;content-
 *     intro&quot;&gt;&lt;p&gt;Lookout&#8217;s mission...`), so
 *     the plugin decodes entities BEFORE stripping tags.
 *     **Thirty-ninth** plugin in the cohort to apply D-08.
 *
 *   - **D-09 — wire-`company_name` `.trim()` omitted.** 0 of 6
 *     wire `company_name` values in the run-293 probe carry pad
 *     bytes (the wire is the fully clean 7-byte `'Lookout'`
 *     form). The plugin reads `listing.company_name` directly
 *     with `'Lookout'` as a defensive fallback; no `.trim()`
 *     applied. **Returns to cohort-default D-09-omitted posture**
 *     after Fivetran's first-cohort D-09 application at run
 *     #292. **Thirty-second cohort plugin** to omit D-09.
 *
 *   - **D-10 — wire-title `.trim()` omitted.** 0 of 6 wire
 *     titles in the run-293 probe carry whitespace padding (the
 *     wire is fully clean). The plugin emits `listing.title`
 *     byte-for-byte without a `.trim()`. **Fifteenth cohort
 *     plugin to omit D-10**.
 *
 *   - **D-11 — fully-clean department pass-through.** Lookout's
 *     wire department names are 0 of 6 populated padded (0 %
 *     pad rate — `'Engineering'`, `'Sales'` — no `' Department'`
 *     structural suffix unlike Fivetran's wire). The plugin
 *     emits the wire `departments[0].name` byte-for-byte without
 *     a `.trim()`. **Twenty-ninth cohort plugin** with fully-
 *     clean department pass-through.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/lookout/jobs';

@SourcePlugin({
  site: Site.LOOKOUT,
  name: 'Lookout',
  category: 'company',
})
@Injectable()
export class LookoutService implements IScraper {
  private readonly logger = new Logger(LookoutService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Lookout: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10 omitted: 0/6 wire titles padded in run-293 probe;
        // pass through byte-for-byte.
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
        const id = `lookout-${jobId}`;

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
            site: Site.LOOKOUT,
            title,
            // D-09 omitted: wire `company_name === 'Lookout'`
            // (7 bytes — fully clean) byte-for-byte across 100 %
            // of run-293 listings; no `.trim()` applied. Returns
            // to cohort-default D-09-omitted posture after
            // Fivetran's first-cohort D-09 application at run
            // #292. **Thirty-second cohort plugin** to omit D-09.
            companyName: listing.company_name ?? 'Lookout',
            // D-04: wire `absolute_url` flows through to `jobUrl`
            // byte-for-byte (preserving the variant-20 `www.`-
            // prefixed brand-domain singular `/careers/job-post`
            // query-only-id shape
            // `www.lookout.com/careers/job-post?gh_jid=<id>`).
            // Fallback uses canonical Greenhouse variant-2 form
            // `job-boards.greenhouse.io/<slug>/jobs/<id>` rather
            // than reconstructing the bare-domain shape, because
            // the fallback can only produce a guaranteed-
            // resolvable URL using the Greenhouse subdomain.
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/lookout/jobs/${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            // D-11 omitted: 0/6 populated wire department names
            // padded in run-293 probe; pass through byte-for-byte.
            // Lookout's wire departments are bare role-domain
            // names (`'Engineering'`, `'Sales'`) without the
            // `' Department'` structural suffix that Fivetran's
            // wire carries.
            department: listing.departments?.[0]?.name ?? null,
          }),
        );
      }

      this.logger.log(`Lookout: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Lookout scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
