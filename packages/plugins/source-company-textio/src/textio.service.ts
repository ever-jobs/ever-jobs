import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Textio, Inc. (textio.com) — operator of the **dominant
 * augmented-writing-as-a-service platform pioneered around
 * the inclusive-language / job-posting-quality / performance-
 * feedback-tone scoring data model** (founded by Kieran
 * Snyder, Jensen Harris, and Kate Matsudaira in 2014 in
 * Seattle, Washington; raised a $20M Series C in February
 * 2018 led by Scale Venture Partners and Bloomberg Beta at
 * peak ~$77M post-money valuation; rebooted post the 2024
 * strategic-restructure with an HR-language-AI focus; ships
 * Textio Hire (job-posting language scoring), Textio Flow
 * (performance-feedback bias-and-tone scoring), Textio Loop
 * (employee-communications language scoring), and the
 * Textio Hire Library (industry-tuned phrase reference
 * corpus) across the augmented-writing / HR-language-AI /
 * inclusive-language analytics segment — alongside
 * competitors Grammarly, Writer, Datapeople, Develop
 * Diverse, and Ongig — with a fully-distributed remote
 * workforce concentrated across Seattle, WA (HQ) and Remote
 * across the United States, with hub presence in NY / MA /
 * IL / HI / TX / CO / CA / OR / WA / MD per the General
 * Application location) — publishes its consolidated
 * careers board through Greenhouse at the bare slug
 * `textio` (case-symmetric with the wire `company_name ===
 * 'Textio'`; see Spec 174 § 10 D-09).
 *
 * **One structural deviation from the Recharge (Spec 167)
 * template** — D-04 sub-axis: variant 2 (canonical
 * Greenhouse host) → **NEW variant 46** (first cohort
 * observation): HTTPS + `www.`-prefixed bare brand-domain
 * `.com` + 2-segment `/careers/apply/` apply-page path
 * **with a trailing slash** + **dual-id query**
 * `?job=<id>&gh_jid=<id>`. The dual-id query is the novel
 * sub-feature — the listing id appears under two keys
 * (vendor-side hand-off shim — Textio's careers front-end
 * reads `job` while Greenhouse forwards `gh_jid`). The trim
 * semantics remain unchanged. **Not a re-spin** (structural
 * NEW variant, not a sub-axis shift).
 *
 *   1. **D-04 — NEW wire-shape variant 46 (first cohort
 *      observation).** `https://www.textio.com/careers/apply/?job=<id>&gh_jid=<id>`
 *      — HTTPS + `www.`-prefixed bare brand-domain `.com` +
 *      2-segment `/careers/apply/` apply-page path **with a
 *      trailing slash** + **dual-id query**
 *      `?job=<id>&gh_jid=<id>`. The **forty-ninth distinct
 *      wire-shape variant** in the company-direct cohort
 *      (after Symphony variant 45 at Spec 172). The plugin
 *      emits `listing.absolute_url` byte-for-byte; the
 *      fallback constructor (when the wire omits
 *      `absolute_url`) defaults to canonical Greenhouse
 *      variant-2 form
 *      `https://job-boards.greenhouse.io/textio/jobs/<id>`
 *      (same fallback strategy as Symphony / Samsara /
 *      Klaviyo / Bird / Collective Health / Netskope).
 *
 *   2. **D-08 — entity-decode-then-tag-strip description pipeline.**
 *      **One-hundred-and-thirtieth** plugin to apply D-08.
 *
 *   3. **D-09 — brand-name trim omitted (case-symmetric).**
 *      Wire `company_name === 'Textio'` byte-for-byte (6
 *      bytes — fully clean, case-symmetric with the
 *      lowercase 6-byte slug `textio`). **One-hundred-and-
 *      twenty-first cohort plugin to omit D-09**.
 *
 *   4. **D-10 — wire-title `.trim()` omitted (clean wire).**
 *      0 of 2 wire titles in the run-384 probe carry pad
 *      bytes (`'Growth Marketing Manager'`, `'Textio's
 *      General Application'` — both clean). The plugin
 *      applies `.trim()` defensively as a safe no-op.
 *      **Thirty-ninth cohort plugin to omit D-10**.
 *
 *   5. **D-11 — wire-department `.trim()` omitted (clean wire).**
 *      0 of 2 unique wire department names padded
 *      (`'Marketing'`, `'General Application'`); the plugin
 *      applies `.trim()` defensively as a safe no-op.
 *      **One-hundred-and-fourth cohort plugin** with fully-
 *      clean department pass-through.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/textio/jobs';

@SourcePlugin({
  site: Site.TEXTIO,
  name: 'Textio',
  category: 'company',
})
@Injectable()
export class TextioService implements IScraper {
  private readonly logger = new Logger(TextioService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Textio: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10 omitted at probe time; .trim() is a safe no-op.
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
        const id = `textio-${jobId}`;

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
            site: Site.TEXTIO,
            title,
            // D-09 omitted: case-symmetric bare-brand wire.
            companyName: listing.company_name ?? 'Textio',
            // D-04: wire `absolute_url` flows through (NEW
            // variant 46 — dual-id query); fallback defaults
            // to canonical variant-2 Greenhouse form because
            // the variant-46 vanity-domain shape may not be
            // guaranteed-resolvable for all listing IDs
            // (same fallback as Symphony / Samsara / Klaviyo
            // / Bird / Collective Health / Netskope).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/textio/jobs/${listing.id}`,
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

      this.logger.log(`Textio: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Textio scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
