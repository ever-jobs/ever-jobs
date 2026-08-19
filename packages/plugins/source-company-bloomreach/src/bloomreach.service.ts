import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Bloomreach, Inc. — operator of the **dominant ecommerce-AI
 * platform combining commerce-experience cloud, content-
 * management, discovery / search, marketing-automation, and
 * customer-data** (founded by Raj De Datta and Ashutosh Garg
 * in 2009 in Mountain View, CA; private since the 2022
 * Goldman Sachs $175M round at ~$2.2B valuation; ships
 * Bloomreach Discovery (search + merchandising), Bloomreach
 * Engagement (CDP + marketing-automation), Bloomreach
 * Content (headless CMS), and Bloomreach Clarity (AI
 * conversational shopping) across the ecommerce-personalisation
 * / B2C-retail / consumer-goods vertical — alongside competitors
 * Algolia, Salesforce Commerce Cloud, Adobe Experience Manager,
 * Klaviyo, Braze — with a hybrid distributed workforce
 * concentrated across Mountain View (HQ), Bratislava (engineering
 * HQ), Brno, Amsterdam, and Remote across the United States and
 * Europe) — publishes its consolidated careers board through
 * Greenhouse at the bare slug `bloomreach` (case-symmetric with
 * the wire `company_name === 'Bloomreach'`; see Spec 139 § 4).
 *
 * **Zero structural deviations from the Doximity (Spec 127)
 * template** — making this the **thirty-fifth** Greenhouse-
 * only company-direct plugin in run-history to ship as a
 * clean re-spin. All five primary axes share with Doximity,
 * with a notable D-10 sub-axis observation:
 *
 *   - **D-04 — wire-shape variant 2 (canonical Greenhouse host).**
 *     `https://job-boards.greenhouse.io/bloomreach/jobs/<id>`.
 *     **Fifty-third** plugin in the cohort to use variant 2.
 *
 *   - **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     **Ninety-fifth** plugin to apply D-08.
 *
 *   - **D-09 — brand-name trim omitted (case-symmetric).** Wire
 *     `company_name === 'Bloomreach'` byte-for-byte (10 bytes —
 *     fully clean, case-symmetric with the lowercase 10-byte
 *     slug `bloomreach`). **Eighty-sixth cohort plugin to omit
 *     D-09**.
 *
 *   - **D-10 — wire-title `.trim()` applied (trailing-pad form).**
 *     10 of 78 wire titles in the run-349 probe carry trailing
 *     padding (~12.8 % pad rate). **Fifty-eighth cohort plugin
 *     to apply D-10**. **First cohort observation of mojibake-
 *     NBSP trailing-pad sub-axis** — 1 of the 10 padded titles
 *     carries a `c3 82 c2 a0` byte-sequence (`'Senior Security
 *     & Compliance Analyst Â '` — wire-side double-UTF-8-
 *     encoded NBSP). JavaScript `String.prototype.trim()`
 *     includes U+00A0 NBSP in its `WhiteSpace` set so the
 *     trailing NBSP is stripped; the residual mojibake `Â`
 *     (U+00C2) byte remains by-design — wire-faithful.
 *
 *   - **D-11 — fully-clean department pass-through.** 0 of 76
 *     wire department names padded across 8 unique departments
 *     (`'Engineering'`, `'G&A - FLS'`, `'G&A - GIST'`, `'G&A -
 *     People'`, `'Marketing'`, `'Operations'`, `'Product'`,
 *     `'Revenue'` — clean multi-token forms with internal
 *     whitespace, ampersands, and hyphens). Pass-through
 *     preserves byte-for-byte. **Seventy-sixth cohort plugin**
 *     with fully-clean department pass-through.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/bloomreach/jobs';

@SourcePlugin({
  site: Site.BLOOMREACH,
  name: 'Bloomreach',
  category: 'company',
})
@Injectable()
export class BloomreachService implements IScraper {
  private readonly logger = new Logger(BloomreachService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Bloomreach: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10 applied (trailing-pad form): 10/78 wire titles
        // padded (~12.8 %); 1 sample carries mojibake-NBSP
        // (`c3 82 c2 a0`) — `.trim()` strips the trailing NBSP,
        // wire-faithful `Â` remains.
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
        const id = `bloomreach-${jobId}`;

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
            site: Site.BLOOMREACH,
            title,
            // D-09 omitted: case-symmetric bare-brand wire.
            companyName: listing.company_name ?? 'Bloomreach',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/bloomreach/jobs/${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            // D-11 omitted: 0/76 wire departments padded.
            department: listing.departments?.[0]?.name ?? null,
          }),
        );
      }

      this.logger.log(`Bloomreach: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Bloomreach scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
