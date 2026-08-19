import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Netskope, Inc. (Netskope.com) — operator of the **dominant
 * SASE / SSE security platform pioneered around the cloud-
 * data-security and Zero-Trust-Network-Access data model**
 * (founded by Sanjay Beri, Krishna Narayanaswamy, Lebin
 * Cheng, and Ravi Ithal in 2012 in Santa Clara, California;
 * raised ~$1.4B across rounds at peak ~$7.5B valuation in
 * January 2024 led by Morgan Stanley Tactical Value; ships
 * Netskope One (the unified SASE platform), Netskope CASB
 * (cloud-access-security-broker), Netskope SWG (secure-web-
 * gateway), Netskope ZTNA (Zero-Trust-Network-Access),
 * Netskope Borderless SD-WAN (cloud-managed-SD-WAN), Netskope
 * Public Cloud Security (CSPM/CIEM/CWPP), and Netskope
 * Intelligent SSE across the SASE / SSE / cloud-data-security
 * / network-security segment — alongside competitors Zscaler,
 * Palo Alto Networks Prisma Access, Cloudflare One, Cisco
 * Umbrella, Cato Networks, Forcepoint ONE, Skyhigh Security,
 * and the SSE-platform lineage of Symantec / Broadcom,
 * iboss, and Versa Networks — with a hybrid distributed
 * workforce concentrated across Santa Clara, California
 * (HQ), Austin, Texas, Bangalore, India, Tokyo, Japan, and
 * Remote across 30+ countries) — publishes its consolidated
 * careers board through Greenhouse at the bare slug
 * `netskope` but emits `absolute_url` on a previously-
 * unobserved vanity-domain shape (see Spec 163 § 4 D-04).
 *
 * **One structural deviation from the Alma (Spec 152)
 * template** — D-04 wire-shape variant 2 → **NEW variant 43
 * (first cohort observation; 46th distinct wire-shape
 * variant)**. Variant 43 = HTTPS + `www.`-prefixed brand-
 * domain (`www.netskope.com`) + 3-segment
 * `/company/careers/open-positions/` path with trailing slash
 * + single `gh_jid` query parameter. Distinct from Klaviyo's
 * variant 19 (1-segment careers path), Bird's variant 41
 * (`.co` TLD), and Collective Health's variant 42 (`jobs.`
 * subdomain) — the only cohort plugin to use a 3-segment
 * `/company/careers/open-positions/` path on a `www.`-
 * prefixed `.com` TLD.
 *
 * Shared with Alma:
 *
 *   - **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     **One-hundred-and-nineteenth** plugin to apply D-08.
 *
 *   - **D-09 — brand-name trim omitted (case-symmetric).** Wire
 *     `company_name === 'Netskope'` byte-for-byte (8 bytes —
 *     fully clean, case-symmetric with the lowercase 8-byte
 *     slug `netskope`). **One-hundred-and-tenth cohort plugin
 *     to omit D-09 — the cohort crosses the 110-plugin D-09-
 *     omission threshold at this run.**
 *
 *   - **D-10 — wire-title `.trim()` APPLIED (trailing-pad
 *     form).** 14 of 130 wire titles in the run-373 probe
 *     carry trailing ASCII-space padding (~10.8 % pad rate,
 *     all trailing-only — `'Channel Sales Manager '`,
 *     `'Director, Regional Sales '`, `'Solutions Architect '`,
 *     plus 11 others). The plugin applies `.trim()` to the
 *     wire `title` byte-for-byte before downstream emit.
 *     **Seventy-third cohort plugin to apply D-10**.
 *
 *   - **D-11 — wire-department `.trim()` omitted (clean wire).**
 *     0 of 21 unique wire department names padded; the plugin
 *     applies `.trim()` defensively as a safe no-op.
 *     **Ninety-fifth cohort plugin** with fully-clean
 *     department pass-through.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/netskope/jobs';

@SourcePlugin({
  site: Site.NETSKOPE,
  name: 'Netskope',
  category: 'company',
})
@Injectable()
export class NetskopeService implements IScraper {
  private readonly logger = new Logger(NetskopeService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Netskope: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10 applied (trailing-pad form): 14/130 padded.
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
        const id = `netskope-${jobId}`;

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
            site: Site.NETSKOPE,
            title,
            // D-09 omitted: case-symmetric bare-brand wire.
            companyName: listing.company_name ?? 'Netskope',
            // D-04: wire `absolute_url` flows through (variant 43);
            // fallback defaults to canonical variant-2 Greenhouse
            // form because the variant-43 vanity-domain shape may
            // not be guaranteed-resolvable for all listing IDs
            // (same fallback as Klaviyo / Bird / Collective Health).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/netskope/jobs/${listing.id}`,
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

      this.logger.log(`Netskope: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Netskope scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
