import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * BigID, Inc. — operator of the **dominant data-discovery +
 * data-classification + data-privacy / governance platform
 * pioneered around the AI-driven-data-intelligence-as-a-
 * service data model** (founded by Dimitri Sirota and Nimrod
 * Vax in 2016 in New York City; raised ~$314M across rounds
 * at peak ~$1.25B valuation in November 2021 led by Advent
 * International; ships BigID Data Discovery, BigID Privacy
 * (DSAR + consent + data-mapping), BigID Security (insider-
 * risk + breach-impact + access-intelligence), BigID
 * Governance, and BigID Cloud DSPM (Data Security Posture
 * Management) across the data-security-posture-management /
 * data-privacy-platform / data-governance segment —
 * alongside competitors Securiti, OneTrust, Collibra,
 * Alation, Varonis, Cyera, Concentric.ai, and IBM Guardium —
 * with a hybrid distributed workforce concentrated across
 * New York City (HQ), Tel Aviv, London, Singapore, and
 * Remote across the United States, Israel, the United
 * Kingdom, the European Union, and the Asia-Pacific region)
 * — publishes its consolidated careers board through
 * Greenhouse at the bare slug `bigid` (the lowercase 5-byte
 * slug; case-asymmetric vs the wire `company_name ===
 * 'BigID'` — THREE-cap PascalCase form with caps at byte
 * indices 0, 3, and 4 forming the embedded `ID` initialism).
 *
 * **One structural deviation from the AssemblyAI (Spec 108)
 * template** — D-04 sub-axis (variant 2 canonical Greenhouse
 * host → variant 36 bare brand-domain dual-id form).
 *
 *   1. **D-04 — wire-shape variant 36 (HTTPS bare brand-
 *      domain `/company/careers/job-details/<id>` id-in-path
 *      + gh_jid query — first cohort observation).** BigID
 *      publishes its `absolute_url` on a **previously-
 *      unobserved** shape
 *      `https://bigid.com/company/careers/job-details/<id>?gh_jid=<id>`.
 *      Sister to Okta's variant 31 (`www.okta.com/company/
 *      careers/opportunity/<id>?gh_jid=<id>`) but with bare
 *      brand-domain (no `www.` prefix) and `/job-details/<id>`
 *      leaf (vs Okta's `opportunity/<id>`). **Second cohort
 *      observation of `/company/careers/<leaf>/<id>` path-
 *      prefix** after Okta — Greenhouse vanity-tenant dual-
 *      id pattern consolidating. **First** plugin in the
 *      cohort to use **wire-shape variant 36** — the
 *      **thirty-ninth distinct wire-shape variant** in the
 *      company-direct cohort.
 *
 *      The plugin emits `listing.absolute_url` byte-for-byte;
 *      the **fallback** `jobUrl` constructor defaults to the
 *      canonical Greenhouse **variant-2** form
 *      `https://job-boards.greenhouse.io/bigid/jobs/<id>`.
 *
 * Shared with AssemblyAI:
 *
 *   - **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     **Ninety-third** plugin to apply D-08.
 *
 *   - **D-09 — brand-name trim omitted with PascalCase THREE-
 *     cap case-asymmetric wire form.** Wire `'BigID'` byte-
 *     for-byte (5 bytes; case-asymmetric vs the lowercase
 *     5-byte slug `bigid` at THREE byte indices: 0, 3, 4 —
 *     all UPPERCASE on the wire, forming the embedded `ID`
 *     initialism). **Eighty-fourth cohort plugin to omit
 *     D-09**. **Second cohort observation of THREE-cap
 *     PascalCase D-09 sub-axis** (after AssemblyAI Spec 108
 *     caps 0/8/9 forming embedded `AI`). Both follow the
 *     `<Brand>+<Acronym>` concat pattern.
 *
 *   - **D-10 — wire-title `.trim()` applied (trailing-pad form).**
 *     2 of 30 wire titles in the run-347 probe carry trailing
 *     ASCII-space padding (~6.7 % pad rate; e.g. `'Performance
 *     Engineer '`, `'Sr. UX & Product Designer '`). **Fifty-
 *     sixth cohort plugin to apply D-10**.
 *
 *   - **D-11 — wire-department `.trim()` APPLIED (trailing-
 *     pad form).** 2 of 10 unique wire department names
 *     padded (`'Sales Development '`, `'Solutions Engineering '`);
 *     listing-level pad rate 9 of 30 (~30 %). The plugin
 *     applies `.trim()` to the wire `departments[0].name`
 *     byte-for-byte before downstream emit. **Thirteenth
 *     cohort plugin to apply D-11**.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/bigid/jobs';

@SourcePlugin({
  site: Site.BIGID,
  name: 'BigID',
  category: 'company',
})
@Injectable()
export class BigIdService implements IScraper {
  private readonly logger = new Logger(BigIdService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`BigID: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10 applied (trailing-pad form): 2/30 wire titles
        // padded (~6.7 %).
        const title = (listing.title ?? '').trim();
        if (!title) continue;

        // D-11 applied (trailing-pad form): trim wire dept
        // name. 2 of 10 unique depts padded (`'Sales
        // Development '`, `'Solutions Engineering '`).
        const dept = (listing.departments?.[0]?.name ?? '').trim() || null;

        if (input.searchTerm) {
          const term = input.searchTerm.toLowerCase();
          const titleMatch = title.toLowerCase().includes(term);
          const deptMatch = (dept ?? '').toLowerCase().includes(term);
          if (!titleMatch && !deptMatch) continue;
        }

        const jobId = listing.id ?? '';
        const id = `bigid-${jobId}`;

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
            site: Site.BIGID,
            title,
            // D-09 omitted: PascalCase THREE-cap case-
            // asymmetric wire form 'BigID' (caps at 0/3/4
            // forming embedded 'ID' initialism).
            companyName: listing.company_name ?? 'BigID',
            // D-04: wire `absolute_url` flows through (variant
            // 36 — HTTPS `bigid.com/company/careers/job-
            // details/<id>?gh_jid=<id>` dual-id form).
            // Fallback uses canonical Greenhouse variant-2.
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/bigid/jobs/${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            // D-11 applied: trim handles `'Sales Development '`
            // and `'Solutions Engineering '`.
            department: dept,
          }),
        );
      }

      this.logger.log(`BigID: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`BigID scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
