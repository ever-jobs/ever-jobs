import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Okta, Inc. — operator of the **dominant identity-and-access-
 * management platform pioneered around the cloud-IDaaS / SSO /
 * MFA / lifecycle-management data model** (founded by Todd
 * McKinnon and Frederic Kerrest in 2009 in San Francisco;
 * public on the NASDAQ since April 2017 IPO under ticker
 * `OKTA` at ~$6.7B initial valuation; ships the Okta Identity
 * Cloud (Workforce Identity, Customer Identity Cloud — Auth0
 * platform acquired March 2021 for $6.5B), Adaptive MFA,
 * Lifecycle Management, API Access Management, and Advanced
 * Server Access across the identity-and-access-management /
 * IDaaS / zero-trust segment — alongside competitors Microsoft
 * Entra ID, Ping Identity, OneLogin, ForgeRock, and AWS IAM
 * Identity Center — with a hybrid distributed workforce
 * concentrated across San Francisco (HQ), Bellevue, Toronto,
 * Krakow, Bangalore, London, and Remote across the United
 * States, Canada, the United Kingdom, Poland, India, the
 * European Union, and the Asia-Pacific region) — publishes its
 * consolidated careers board through Greenhouse at the bare
 * slug `okta` (case-symmetric with the wire `company_name ===
 * 'Okta'`; see Spec 115 § 10 D-05).
 *
 * **One structural deviation from the Fastly (Spec 113)
 * template** — D-04 wire-shape variant 31 (first cohort plugin
 * to use variant 31; **first cohort observation of HTTPS-scheme
 * `www.`-prefixed brand-domain `/company/careers/opportunity/<id>`
 * id-in-path + gh_jid query**). Variant 31 is the id-in-path +
 * gh_jid query sister to Fastly's variant 30 (query-only id).
 * All other axes share with Fastly: D-08 entity-decode-then-
 * tag-strip, D-09 omitted with case-symmetric bare-brand wire,
 * D-10 applied (Okta 54/358 padded ~15.1 % — eighth-largest
 * D-10 pad rate observed in cohort), D-11 omitted with **first-
 * cohort suffix-numeric-ID dept naming sub-axis** (`<name>-<numeric ID>`).
 *
 *   1. **D-04 — wire-shape variant 31 (HTTPS-scheme `www.`-
 *      prefixed brand-domain `/company/careers/opportunity/<id>`
 *      id-in-path + gh_jid query — first cohort observation).**
 *      Okta publishes its `absolute_url` on a **previously-
 *      unobserved** shape
 *      `https://www.okta.com/company/careers/opportunity/<id>?gh_jid=<id>`
 *      with four sub-axes:
 *      a) **HTTPS scheme.**
 *      b) **`www.`-prefixed brand-domain** — same `www.` prefix
 *         as variants 16, 19, 20, 22, 30.
 *      c) **`/company/careers/opportunity/<id>` path** — first
 *         cohort observation of `/company/` prefix-segment AND
 *         singular `opportunity/<id>` leaf form (ClassPass uses
 *         plural `careers/opportunities/<id>`).
 *      d) **id-in-path + gh_jid query (dual-id form)** — Fastly
 *         variant 30 has query-only id; Okta variant 31 has
 *         id-in-path AND gh_jid query.
 *      **First** plugin in the cohort to use **wire-shape variant
 *      31** — the **thirty-fourth distinct wire-shape variant**
 *      in the company-direct cohort.
 *
 *      The plugin emits `listing.absolute_url` byte-for-byte;
 *      the **fallback** `jobUrl` constructor defaults to the
 *      canonical Greenhouse **variant-2** form
 *      `https://job-boards.greenhouse.io/okta/jobs/<id>`.
 *
 * Shared with Fastly:
 *
 *   - **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     **Seventy-first** plugin to apply D-08.
 *
 *   - **D-09 — brand-name trim omitted (case-symmetric).** Wire
 *     `company_name === 'Okta'` byte-for-byte (4 bytes —
 *     fully clean, case-symmetric with the lowercase 4-byte
 *     slug `okta`). **Sixty-second cohort plugin to omit D-09**.
 *
 *   - **D-10 — wire-title `.trim()` applied (trailing-pad form).**
 *     54 of 358 wire titles in the run-325 probe carry trailing
 *     ASCII-space padding (~15.1 % pad rate; e.g. `'AI Operations
 *     Lead '`, `'Area Sales Director, Enterprise '`,
 *     `'Communications Data and Insights Manager '`, plus 51
 *     others). All trailing-only. **Thirty-ninth cohort plugin
 *     to apply D-10**.
 *
 *   - **D-11 — fully-clean department pass-through with FIRST-
 *     COHORT suffix-numeric-ID dept naming sub-axis.** 0 of 358
 *     wire department names padded across 76 unique departments
 *     — but most follow a `<name>-<numeric ID>` suffix
 *     convention (`'Accounting Operations-121'`, `'Auth0
 *     DevRel-494'`, `'BT Engineering Services-779'`, plus 73
 *     others). **Second cohort observation of numeric IDs in
 *     department names** after Constant Contact's prefix
 *     convention (Spec 111 — `'100 Engineering'`, etc.); Okta
 *     is the **first** cohort observation of the **suffix**
 *     form. Standard pass-through preserves the suffix bytes
 *     byte-for-byte. **Fifty-sixth cohort plugin** with fully-
 *     clean department pass-through.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/okta/jobs';

@SourcePlugin({
  site: Site.OKTA,
  name: 'Okta',
  category: 'company',
})
@Injectable()
export class OktaService implements IScraper {
  private readonly logger = new Logger(OktaService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Okta: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10 applied (trailing-pad form): 54/358 wire titles
        // padded (~15.1 %).
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
        const id = `okta-${jobId}`;

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
            site: Site.OKTA,
            title,
            // D-09 omitted: case-symmetric bare-brand wire.
            companyName: listing.company_name ?? 'Okta',
            // D-04: wire `absolute_url` flows through (variant 31
            // — HTTPS `www.okta.com/company/careers/opportunity/<id>?gh_jid=`).
            // Fallback uses canonical Greenhouse variant-2.
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/okta/jobs/${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            // D-11 omitted: 0/358 wire departments padded
            // (suffix-numeric-ID names preserved byte-for-byte).
            department: listing.departments?.[0]?.name ?? null,
          }),
        );
      }

      this.logger.log(`Okta: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Okta scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
