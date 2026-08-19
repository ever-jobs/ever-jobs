import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Descope, Inc. — operator of the **dominant developer-first
 * authentication-as-a-service platform pioneered around the
 * no-code-CIAM / passwordless-auth / drag-drop-flows data
 * model** (founded by Slavik Markovich, Rishi Bhargava, Hila
 * Stern, Hadas Cassorla, Limor Bergman Gross, Meir Wahnon,
 * and Gilad Shriki in 2022 in Los Altos, California; raised
 * ~$53M across rounds at peak ~$200M valuation in February
 * 2022 led by Lightspeed Venture Partners and GGV Capital;
 * ships Descope Authentication (passwordless / SSO / MFA /
 * passkeys / social login), Flows (drag-drop auth-flow
 * builder), Token Exchange, and Identity Federation across
 * the customer-identity-and-access-management (CIAM) /
 * authentication-as-a-service / passwordless segment —
 * alongside competitors Auth0 (Okta), Clerk, Stytch, FrontEgg,
 * WorkOS, and SuperTokens — with a hybrid distributed
 * workforce concentrated across Los Altos (HQ), Tel Aviv, and
 * Remote across the United States and Israel) — publishes
 * its consolidated careers board through Greenhouse at the
 * bare slug `descope` (case-symmetric with the wire
 * `company_name === 'Descope'`; see Spec 125 § 10 D-05).
 *
 * **One structural deviation from the Branch (Spec 121)
 * template** — D-11 applied (Branch 0/11 padded omitted;
 * Descope 2 of 3 unique dept names padded — `'Customer
 * Success '` and `'Engineering '`; listing-level pad rate
 * 6 of 8 ~75 % — the **highest D-11 listing-level pad rate
 * observed in the cohort to date**, surpassing AssemblyAI's
 * ~43 %).
 *
 *   1. **D-11 — wire-department `.trim()` APPLIED (trailing-
 *      pad form).** 2 of 3 unique wire department names
 *      padded; listing-level pad rate 6 of 8 (~75 %). The
 *      plugin applies `.trim()` to the wire
 *      `departments[0].name` byte-for-byte before downstream
 *      emit. **Eleventh cohort plugin to apply D-11**.
 *
 * Shared with Branch:
 *
 *   - **D-04 — wire-shape variant 2 (canonical Greenhouse host).**
 *     `https://job-boards.greenhouse.io/descope/jobs/<id>`.
 *     **Forty-fourth** plugin in the cohort to use variant 2.
 *
 *   - **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     **Eighty-first** plugin to apply D-08.
 *
 *   - **D-09 — brand-name trim omitted (case-symmetric).** Wire
 *     `company_name === 'Descope'` byte-for-byte (7 bytes —
 *     fully clean, case-symmetric with the lowercase 7-byte
 *     slug `descope`). **Seventy-second cohort plugin to omit
 *     D-09**.
 *
 *   - **D-10 — wire-title `.trim()` omitted.** 0 of 8 wire
 *     titles in the run-335 probe carry trailing pad bytes;
 *     the plugin emits `listing.title` byte-for-byte without
 *     a `.trim()`. **Twenty-fourth cohort plugin to omit D-10**.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/descope/jobs';

@SourcePlugin({
  site: Site.DESCOPE,
  name: 'Descope',
  category: 'company',
})
@Injectable()
export class DescopeService implements IScraper {
  private readonly logger = new Logger(DescopeService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Descope: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10 omitted: emit wire title byte-for-byte (no trim).
        const title = listing.title ?? '';
        if (!title) continue;

        // D-11 applied (trailing-pad form): trim wire dept name.
        // 6/8 listings carry padded `'Customer Success '` /
        // `'Engineering '`.
        const dept = (listing.departments?.[0]?.name ?? '').trim() || null;

        if (input.searchTerm) {
          const term = input.searchTerm.toLowerCase();
          const titleMatch = title.toLowerCase().includes(term);
          const deptMatch = (dept ?? '').toLowerCase().includes(term);
          if (!titleMatch && !deptMatch) continue;
        }

        const jobId = listing.id ?? '';
        const id = `descope-${jobId}`;

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
            site: Site.DESCOPE,
            title,
            // D-09 omitted: case-symmetric bare-brand wire.
            companyName: listing.company_name ?? 'Descope',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/descope/jobs/${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            // D-11 applied: trim handles 6/8 padded listings.
            department: dept,
          }),
        );
      }

      this.logger.log(`Descope: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Descope scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
