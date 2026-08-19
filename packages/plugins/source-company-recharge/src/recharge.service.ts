import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Recharge Payments, Inc. (RechargePayments.com) — operator
 * of the **dominant Shopify-native subscription-commerce
 * platform pioneered around the recurring-product-billing
 * data model** (founded by Oisin O'Connor and Mike Flynn in
 * 2014 in Santa Monica, California; raised ~$277M Series B
 * in May 2021 led by Summit Partners and ICONIQ Growth at
 * peak ~$2.1B valuation; ships Recharge Subscriptions (the
 * core recurring-billing engine), Recharge Customer Portal
 * (subscriber self-serve surface), Recharge Bundles
 * (curated-bundle subscriptions), Recharge Rewards (loyalty-
 * program-into-subscription), Recharge Apps (Shopify
 * marketplace integrations), and Recharge Marketing Tools
 * (lifecycle / churn-prevention / win-back automation) across
 * the Shopify-subscription-commerce / recurring-product-
 * billing segment — alongside competitors Bold Subscriptions,
 * Skio, Smartrr, Loop Subscriptions, Stay AI, Awtomic, and
 * the Shopify-native Subscription APIs platform — with a
 * fully-distributed remote workforce concentrated across
 * Santa Monica, California (HQ), Toronto, Canada, and Remote
 * across the United States, Canada, and the United Kingdom)
 * — publishes its consolidated careers board through
 * Greenhouse at the bare slug `recharge` (case-symmetric
 * with the wire `company_name === 'Recharge'`; see Spec 167
 * § 10 D-05).
 *
 * **Zero structural deviations from the Maven (Spec 162)
 * template** — case-symmetric brand wire, variant 2 URL,
 * D-08 entity-decode-then-tag-strip, D-10 omitted, D-11
 * omitted. **Forty-ninth clean re-spin** in run-history.
 *
 *   1. **D-04 — wire-shape variant 2 (canonical Greenhouse host).**
 *     `https://job-boards.greenhouse.io/recharge/jobs/<id>`.
 *     **Seventy-first** plugin in the cohort to use variant 2.
 *
 *   2. **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     **One-hundred-and-twenty-third** plugin to apply D-08.
 *
 *   3. **D-09 — brand-name trim omitted (case-symmetric).** Wire
 *     `company_name === 'Recharge'` byte-for-byte (8 bytes —
 *     fully clean, case-symmetric with the lowercase 8-byte
 *     slug `recharge`). **One-hundred-and-fourteenth cohort
 *     plugin to omit D-09**.
 *
 *   4. **D-10 — wire-title `.trim()` omitted (clean wire).**
 *     0 of 4 wire titles padded; the plugin applies `.trim()`
 *     defensively as a safe no-op. **Thirty-sixth cohort
 *     plugin to omit D-10**.
 *
 *   5. **D-11 — wire-department `.trim()` omitted (clean wire).**
 *     0 of 4 unique wire department names padded
 *     (`'Corporate - IT'`, `'Data'`, `'Engineering General'`,
 *     `'FP&A'`); the plugin applies `.trim()` defensively as
 *     a safe no-op. **Ninety-ninth cohort plugin** with fully-
 *     clean department pass-through.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/recharge/jobs';

@SourcePlugin({
  site: Site.RECHARGE,
  name: 'Recharge',
  category: 'company',
})
@Injectable()
export class RechargeService implements IScraper {
  private readonly logger = new Logger(RechargeService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Recharge: fetching ${url}`);

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
        const id = `recharge-${jobId}`;

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
            site: Site.RECHARGE,
            title,
            // D-09 omitted: case-symmetric bare-brand wire.
            companyName: listing.company_name ?? 'Recharge',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/recharge/jobs/${listing.id}`,
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

      this.logger.log(`Recharge: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Recharge scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
