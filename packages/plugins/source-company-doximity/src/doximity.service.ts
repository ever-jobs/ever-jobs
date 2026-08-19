import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Doximity, Inc. — operator of the **dominant US-physician
 * professional-network + telehealth-tooling platform pioneered
 * around the verified-clinician-credentialing-as-a-service
 * data model** (founded by Jeff Tangney, Shari Buck, and Nate
 * Gross in 2010 in San Francisco; public on the NYSE since
 * June 2021 IPO under ticker `DOCS` at ~$10B initial
 * valuation; ships Doximity Profile (~80 % of US physicians
 * have a profile), Doximity Dialer (HIPAA-compliant secure-
 * call masking), Doximity Mailbox (secure HIPAA messaging),
 * Doximity News (medical-news feed), Doximity Op-Ed
 * (continuing-medical-education content), and Doximity Career
 * Center across the physician-network / telehealth-tooling /
 * pharma-marketing-ops segment — alongside competitors Sermo,
 * Figure 1, and Epocrates — with a hybrid distributed
 * workforce concentrated across San Francisco (HQ) and Remote
 * across the United States) — publishes its consolidated
 * careers board through Greenhouse at the bare slug `doximity`
 * (case-symmetric with the wire `company_name === 'Doximity'`;
 * see Spec 127 § 10 D-05).
 *
 * **Zero structural deviations from the Contentful (Spec 124)
 * template** — making this the **twenty-ninth** Greenhouse-
 * only company-direct plugin in run-history to ship as a
 * clean re-spin. All five primary axes share with Contentful:
 *
 *   - **D-04 — wire-shape variant 2 (canonical Greenhouse host).**
 *     `https://job-boards.greenhouse.io/doximity/jobs/<id>`.
 *     **Forty-sixth** plugin in the cohort to use variant 2.
 *
 *   - **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     **Eighty-third** plugin to apply D-08.
 *
 *   - **D-09 — brand-name trim omitted (case-symmetric).** Wire
 *     `company_name === 'Doximity'` byte-for-byte (8 bytes —
 *     fully clean, case-symmetric with the lowercase 8-byte
 *     slug `doximity`). **Seventy-fourth cohort plugin to
 *     omit D-09**.
 *
 *   - **D-10 — wire-title `.trim()` applied (trailing-pad form).**
 *     2 of 15 wire titles in the run-337 probe carry trailing
 *     ASCII-space padding (~13.3 % pad rate; e.g. `'Data
 *     Analyst '`, `'Product Marketing Manager '`). **Forty-
 *     seventh cohort plugin to apply D-10**.
 *
 *   - **D-11 — fully-clean department pass-through.** 0 of 15
 *     wire department names padded across 7 unique departments
 *     (`'Data'`, `'Engineering'`, `'Finance & Accounting'`,
 *     `'Marketing'`, `'Mobile Engineering'`, `'Sales & Client
 *     Success'`, `'Summer Internships'` — clean multi-token
 *     forms with internal whitespace and ampersands). **Sixty-
 *     sixth cohort plugin** with fully-clean department pass-
 *     through.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/doximity/jobs';

@SourcePlugin({
  site: Site.DOXIMITY,
  name: 'Doximity',
  category: 'company',
})
@Injectable()
export class DoximityService implements IScraper {
  private readonly logger = new Logger(DoximityService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Doximity: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10 applied (trailing-pad form): 2/15 wire titles
        // padded (~13.3 %).
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
        const id = `doximity-${jobId}`;

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
            site: Site.DOXIMITY,
            title,
            // D-09 omitted: case-symmetric bare-brand wire.
            companyName: listing.company_name ?? 'Doximity',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/doximity/jobs/${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            // D-11 omitted: 0/15 wire departments padded.
            department: listing.departments?.[0]?.name ?? null,
          }),
        );
      }

      this.logger.log(`Doximity: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Doximity scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
