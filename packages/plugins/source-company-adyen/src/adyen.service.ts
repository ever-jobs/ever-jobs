import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Adyen N.V. — operator of the dominant European payment-
 * processing platform pioneered around the unified-acquiring-and-
 * issuing single-payment-platform data model (founded by Pieter
 * van der Does and Arnout Schuijff in 2006 in Amsterdam; IPO'd
 * on Euronext Amsterdam as `ADYEN` in June 2018; ships a unified
 * acquiring + issuing + risk-management + tokenisation product
 * across the merchant-payments segment — alongside competitors
 * Stripe, Worldpay, PayPal Braintree, Checkout.com, and Block —
 * with a hybrid distributed workforce concentrated across
 * Amsterdam, San Francisco, Singapore, São Paulo, and Remote
 * across Europe, the Americas, and Asia-Pacific) — publishes its
 * consolidated careers board through Greenhouse at the bare slug
 * `adyen` (the lowercase brand name; case-symmetric with the
 * wire `company_name === 'Adyen'`; see Spec 090 § 10 D-05).
 *
 * **Zero structural deviations from the Marqeta (Spec 084)
 * template** — making this the **eighth** Greenhouse-only
 * company-direct plugin in run-history to ship as a clean re-
 * spin (after Coursera off Chime at run #278, Flexport off Faire
 * at run #280, Glossier off Flexport at run #282, Marqeta off
 * Calendly at run #294, New Relic off Maven Clinic at run #295,
 * Scopely off Marqeta at run #297, and Typeform-which-was-
 * actually-one-deviation off Lattice at run #299).
 *
 * **First plugin in the sixth fresh probe sweep.** The run-300
 * probe sweep across ~80 candidate slugs found 17 fresh non-
 * empty live hits forming the new candidate pool: adyen,
 * benevity, billcom, bobbie, cerebral, coalition,
 * dollarshaveclub, hellofresh, misfitsmarket, monzo, n26,
 * planetscale, sofi, stockx, sweetgreen, xai, plus 2 deferred-
 * empty (gather, calm).
 *
 * Shared with Marqeta:
 *
 *   - **D-04 — wire-shape variant 2 (canonical Greenhouse host).**
 *     `https://job-boards.greenhouse.io/adyen/jobs/<id>`.
 *     **Twenty-second** plugin in the cohort to use variant 2.
 *
 *   - **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     **Forty-sixth** plugin to apply D-08.
 *
 *   - **D-09 — brand-name trim omitted (case-symmetric).** Wire
 *     `company_name === 'Adyen'` byte-for-byte (5 bytes — fully
 *     clean, case-symmetric with the lowercase slug). **Thirty-
 *     ninth cohort plugin to omit D-09**.
 *
 *   - **D-10 — wire-title `.trim()` applied.** 26 of 260 wire
 *     titles in the run-300 probe carry trailing ASCII-space
 *     padding (~10 % pad rate). **Twenty-fifth cohort plugin to
 *     apply D-10**.
 *
 *   - **D-11 — fully-clean department pass-through.** 0 of 260
 *     wire department names padded (`'Account Management'`,
 *     `'Finance'`, `'Merchant Operations'`, `'Infrastructure'`,
 *     `'Compliance'`, etc. — clean multi-token forms with
 *     internal whitespace). **Thirty-fifth cohort plugin** with
 *     fully-clean department pass-through.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/adyen/jobs';

@SourcePlugin({
  site: Site.ADYEN,
  name: 'Adyen',
  category: 'company',
})
@Injectable()
export class AdyenService implements IScraper {
  private readonly logger = new Logger(AdyenService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Adyen: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10: trim wire title — 26/260 padded in run-300 probe.
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
        const id = `adyen-${jobId}`;

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
            site: Site.ADYEN,
            title,
            // D-09 omitted: case-symmetric bare-brand wire.
            companyName: listing.company_name ?? 'Adyen',
            // D-04: wire `absolute_url` flows through (variant 2);
            // fallback uses canonical Greenhouse variant-2 form.
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/adyen/jobs/${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            // D-11 omitted: 0/260 wire departments padded.
            department: listing.departments?.[0]?.name ?? null,
          }),
        );
      }

      this.logger.log(`Adyen: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Adyen scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
