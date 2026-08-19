import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Melio Payments, Inc. (Melio.com) — operator of the
 * **dominant SMB B2B-payments platform pioneered around the
 * accounts-payable-bill-pay-as-a-service data model**
 * (founded by Matan Bar, Ilan Atias, and Ziv Paz in 2018 in
 * New York City; raised ~$507M across rounds at peak ~$4B
 * valuation in September 2021 led by Coatue Management and
 * Tiger Global Management; ships Melio AP (vendor bill
 * payments), Melio AR (invoice collection), Melio Pay-by-
 * Card, Melio for QuickBooks / Xero / Sage / Zoho
 * integrations, and Melio Marketing Partners (white-labeled
 * embedded-payments) across the SMB-B2B-payments / accounts-
 * payable-automation segment — alongside competitors Bill
 * (BILL Holdings), Tipalti, Plastiq, Coupa, Stampli,
 * AvidXchange, Routable, and Stripe Bill Pay — with a hybrid
 * distributed workforce concentrated across New York City
 * (HQ), Tel Aviv, Denver, and Remote across the United States
 * and Israel) — publishes its consolidated careers board
 * through Greenhouse at the bare slug `melio` (case-symmetric
 * with the wire `company_name === 'Melio'`; see Spec 130 § 10
 * D-05).
 *
 * **One structural deviation from the Descope (Spec 125)
 * template** — D-10 applied (Descope 0/8 padded omitted;
 * Melio 2/20 padded ~10 % applied — `'Director of FP&A '`,
 * `'Staff Full Stack Engineer '`).
 *
 *   1. **D-10 — wire-title `.trim()` APPLIED (trailing-pad
 *      form).** 2 of 20 wire titles in the run-340 probe
 *      carry trailing ASCII-space padding (~10 % pad rate,
 *      all trailing-only). The plugin applies `.trim()` to
 *      the wire `title` byte-for-byte before downstream
 *      emit. **Fiftieth cohort plugin to apply D-10 — the
 *      cohort crosses the 50-plugin D-10-application
 *      threshold at this run.**
 *
 * Shared with Descope:
 *
 *   - **D-04 — wire-shape variant 2 (canonical Greenhouse host).**
 *     `https://job-boards.greenhouse.io/melio/jobs/<id>`.
 *     **Forty-seventh** plugin in the cohort to use variant 2.
 *
 *   - **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     **Eighty-sixth** plugin to apply D-08.
 *
 *   - **D-09 — brand-name trim omitted (case-symmetric).** Wire
 *     `company_name === 'Melio'` byte-for-byte (5 bytes —
 *     fully clean, case-symmetric with the lowercase 5-byte
 *     slug `melio`). **Seventy-seventh cohort plugin to omit
 *     D-09**.
 *
 *   - **D-11 — wire-department `.trim()` APPLIED (trailing-
 *     pad form).** 1 of 8 unique wire department names padded
 *     (`'Design '`); the plugin applies `.trim()` to the wire
 *     `departments[0].name` byte-for-byte before downstream
 *     emit. **Twelfth cohort plugin to apply D-11**.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/melio/jobs';

@SourcePlugin({
  site: Site.MELIO,
  name: 'Melio',
  category: 'company',
})
@Injectable()
export class MelioService implements IScraper {
  private readonly logger = new Logger(MelioService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Melio: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10 applied (trailing-pad form): 2/20 wire titles
        // padded (~10 %).
        const title = (listing.title ?? '').trim();
        if (!title) continue;

        // D-11 applied (trailing-pad form): trim wire dept
        // name to handle 'Design '.
        const dept = (listing.departments?.[0]?.name ?? '').trim() || null;

        if (input.searchTerm) {
          const term = input.searchTerm.toLowerCase();
          const titleMatch = title.toLowerCase().includes(term);
          const deptMatch = (dept ?? '').toLowerCase().includes(term);
          if (!titleMatch && !deptMatch) continue;
        }

        const jobId = listing.id ?? '';
        const id = `melio-${jobId}`;

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
            site: Site.MELIO,
            title,
            // D-09 omitted: case-symmetric bare-brand wire.
            companyName: listing.company_name ?? 'Melio',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/melio/jobs/${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            // D-11 applied: trim handles `'Design '`.
            department: dept,
          }),
        );
      }

      this.logger.log(`Melio: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Melio scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
