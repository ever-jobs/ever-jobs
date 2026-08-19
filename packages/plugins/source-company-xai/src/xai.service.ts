import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * xAI Corp. — operator of the **dominant frontier-AI / Grok
 * platform pioneered around the unfiltered conversational-AI +
 * X.com-realtime-data-feed integration model** (founded by Elon
 * Musk, Igor Babuschkin, Tony Wu, Greg Yang, Christian Szegedy,
 * and others in March 2023; raised ~$24B+ across rounds at
 * peak ~$200B valuation in 2025–2026 led by Andreessen Horowitz,
 * Sequoia, Valor Equity, BlackRock, and Saudi PIF; merged
 * operationally with X (formerly Twitter) in March 2025; ships
 * the Grok consumer / Grok Pro / Grok for Government /
 * Grok-3 / Grok-4 / Grok Imagine product line plus the Memphis
 * "Colossus" GPU supercluster and the Macrohard enterprise-AI
 * SaaS — alongside competitors OpenAI, Anthropic, Google
 * DeepMind, Meta AI, and Mistral — with a workforce
 * concentrated across San Francisco / Palo Alto, Memphis TN
 * (Colossus data center), and Remote across the United States)
 * — publishes its consolidated careers board through Greenhouse
 * at the bare slug `xai` (the lowercase concatenated brand-stem;
 * case-asymmetric with the wire `company_name === 'xAI'` mixed-
 * case 3-byte form — see Spec 105 § 10 D-05).
 *
 * **One structural deviation from the Adyen (Spec 090)
 * template** — D-09 sub-axis (xAI's mixed-case TWO-cap-at-
 * indices-1/2 wire form `'xAI'` vs Adyen's case-symmetric
 * 5-byte `'Adyen'`).
 *
 *   1. **D-09 — brand-name trim omitted with FIRST-COHORT
 *      mixed-case TWO-CAP-at-1/2 short wire form.** Wire
 *      `company_name === 'xAI'` byte-for-byte (3 bytes — fully
 *      clean; 0 of 249 padded). Slug `xai` is 3 bytes lowercase;
 *      case-asymmetric at TWO byte indices — `'A'` vs `'a'` at
 *      index 1 AND `'I'` vs `'i'` at index 2. **First cohort
 *      observation of TWO-cap mixed-case with LOWERCASE first
 *      letter and UPPERCASE last two letters in a compact 3-byte
 *      form** — distinct from prior TWO-cap forms in SoFi
 *      (Spec 102, caps at 0/2 — uppercase first + uppercase
 *      mid) and StockX (Spec 103, caps at 0/5 — uppercase
 *      first + uppercase last). xAI inverts the first-letter
 *      cap convention, mirroring iPhone-style branding. **Fifty-
 *      third cohort plugin to omit D-09**.
 *
 * Shared with Adyen:
 *
 *   - **D-04 — wire-shape variant 2 (canonical Greenhouse
 *     host).** `https://job-boards.greenhouse.io/xai/jobs/<id>`.
 *     **Thirtieth** plugin in the cohort to use variant 2.
 *
 *   - **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     **Sixty-first** plugin to apply D-08.
 *
 *   - **D-10 — wire-title `.trim()` applied (trailing-pad form).**
 *     18 of 249 wire titles in the run-315 probe carry trailing
 *     ASCII-space padding (~7.2 % pad rate — close to Adyen's
 *     ~10 % rate). **Twenty-ninth cohort plugin to apply D-10**.
 *
 *   - **D-11 — fully-clean department pass-through.** 0 of 249
 *     wire department names padded across 24 unique departments
 *     (`'Data Center'`, `'Design'`, `'Engineering'`, `'Finance'`,
 *     `'Financial'`, `'Grok for Government'`, `'Human Data'`,
 *     `'Information Security'`, plus 16 others — clean multi-
 *     token forms with internal whitespace). **Forty-sixth
 *     cohort plugin** with fully-clean department pass-through.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/xai/jobs';

@SourcePlugin({
  site: Site.XAI,
  name: 'xAI',
  category: 'company',
})
@Injectable()
export class XaiService implements IScraper {
  private readonly logger = new Logger(XaiService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`xAI: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10 applied (trailing-pad form): 18/249 wire titles
        // padded (~7.2 %).
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
        const id = `xai-${jobId}`;

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
            site: Site.XAI,
            title,
            // D-09 omitted: mixed-case TWO-cap-at-1/2 short wire
            // form `'xAI'` (3 bytes; lowercase first letter +
            // uppercase last two letters).
            companyName: listing.company_name ?? 'xAI',
            // D-04: wire `absolute_url` flows through (variant 2
            // — canonical Greenhouse host); fallback uses the
            // same canonical variant-2 form.
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/xai/jobs/${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            // D-11 omitted: 0/249 wire departments padded.
            department: listing.departments?.[0]?.name ?? null,
          }),
        );
      }

      this.logger.log(`xAI: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`xAI scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
