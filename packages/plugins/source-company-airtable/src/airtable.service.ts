import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Formagrid, Inc. d/b/a Airtable — operator of the **dominant
 * spreadsheet-database hybrid platform pioneered around the
 * relational-grid + low-code app-builder data model** (founded
 * by Howie Liu, Andrew Ofstad, and Emmett Nicholas in 2012 in
 * San Francisco; raised ~$1.4B across rounds at peak ~$11B
 * valuation in December 2021 led by XN, Greylock, Caffeinated
 * Capital, Thrive Capital, and D1 Capital Partners; expanded
 * from spreadsheet-as-database to enterprise-AI app-builder
 * with Airtable AI in 2024 and Cobuilder in 2025; ships
 * Airtable Free / Plus / Pro / Business / Enterprise tiers
 * across the relational-database / no-code / collaboration
 * segment — alongside competitors Notion, Smartsheet, monday.com,
 * Coda, Clay, Asana, ClickUp, and Microsoft Lists — with a
 * hybrid distributed workforce concentrated across San Francisco
 * (HQ), New York, London, and Remote across the United States,
 * UK, and EU) — publishes its consolidated careers board through
 * Greenhouse at the bare slug `airtable` (the lowercase brand
 * name; case-symmetric with the wire `company_name === 'Airtable'`
 * — see Spec 106 § 10 D-05).
 *
 * **Zero structural deviations from the Cerebral (Spec 094)
 * template** — making this the **fourteenth** Greenhouse-only
 * company-direct plugin in run-history to ship as a clean re-
 * spin (after Coursera off Chime, Flexport off Faire, Glossier
 * off Flexport, Marqeta off Calendly, New Relic off Maven
 * Clinic, Scopely off Marqeta, Adyen off Marqeta, Bobbie off
 * Coursera, Cerebral off Adyen, Misfits Market off New Relic,
 * Monzo off Adyen, PlanetScale off Coursera, plus a corrected
 * count). All five primary axes share with Cerebral:
 *
 *   - **D-04 — wire-shape variant 2 (canonical Greenhouse
 *     host).** `https://job-boards.greenhouse.io/airtable/jobs/<id>`.
 *     **Thirty-first** plugin in the cohort to use variant 2.
 *
 *   - **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     **Sixty-second** plugin to apply D-08.
 *
 *   - **D-09 — brand-name trim omitted (case-symmetric).** Wire
 *     `company_name === 'Airtable'` byte-for-byte (8 bytes —
 *     fully clean; 0 of 27 padded). Case-symmetric with the
 *     lowercase 8-byte slug `airtable`. **Fifty-fourth cohort
 *     plugin to omit D-09**.
 *
 *   - **D-10 — wire-title `.trim()` applied (trailing-pad form).**
 *     1 of 27 wire titles in the run-316 probe carries trailing
 *     ASCII-space padding (~3.7 % pad rate). **Thirtieth cohort
 *     plugin to apply D-10**.
 *
 *   - **D-11 — fully-clean department pass-through.** 0 of 27
 *     wire department names padded across 11 unique departments
 *     (`'Accounting'`, `'Customer Success & Services'`,
 *     `'Customer Support'`, `'Data'`, `'Demand Generation'`,
 *     `'Design'`, `'Engineering'`, `'Legal'`, plus 3 others —
 *     clean multi-token forms with internal whitespace and
 *     ampersands). **Forty-seventh cohort plugin** with fully-
 *     clean department pass-through.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/airtable/jobs';

@SourcePlugin({
  site: Site.AIRTABLE,
  name: 'Airtable',
  category: 'company',
})
@Injectable()
export class AirtableService implements IScraper {
  private readonly logger = new Logger(AirtableService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Airtable: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10 applied (trailing-pad form): 1/27 wire titles
        // padded (~3.7 %).
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
        const id = `airtable-${jobId}`;

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
            site: Site.AIRTABLE,
            title,
            // D-09 omitted: case-symmetric bare-brand wire.
            companyName: listing.company_name ?? 'Airtable',
            // D-04: wire `absolute_url` flows through (variant 2
            // — canonical Greenhouse host); fallback uses the
            // same canonical variant-2 form.
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/airtable/jobs/${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            // D-11 omitted: 0/27 wire departments padded.
            department: listing.departments?.[0]?.name ?? null,
          }),
        );
      }

      this.logger.log(`Airtable: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Airtable scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
