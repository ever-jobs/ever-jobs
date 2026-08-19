import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Alliance Defending Freedom — Christian conservative legal advocacy nonprofit litigating religious liberty and free speech cases.
 *
 * Alliance Defending Freedom (ADF) is a U.S.-based Christian
 * conservative legal advocacy organization and nonprofit law firm
 * focused on religious liberty, free speech, and related
 * constitutional litigation. It operates from Scottsdale, Arizona,
 * with additional offices including Lansdowne, Virginia, Washington
 * D.C., and Dallas, Texas. Beyond litigation, ADF runs supporting
 * programs such as the Blackstone Legal Fellowship
 * professional-development training and a membership/alliance network,
 * staffed by departments spanning Finance, Communications, Facilities,
 * and Strategic Initiatives.
 *
 * Sector: Legal advocacy / Nonprofit. HQ: Scottsdale, AZ, USA.
 *
 * Highlights:
 *   - Multi-office U.S. footprint: Scottsdale AZ (HQ), Lansdowne VA,
 *     Washington D.C., and Dallas TX
 *   - Runs the Blackstone program for legal professional development
 *     alongside its litigation work
 *   - Maintains a membership/alliance network via a Church and
 *     Ministry Alliance department
 *   - Functions as a nonprofit with internal Finance, Communications,
 *     Facilities, and Strategic Initiatives teams
 *
 * Source profile (Spec 235):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/alliancedefendingfreedom/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'Alliance Defending Freedom'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 31 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/alliancedefendingfreedom/jobs';

@SourcePlugin({
  site: Site.ALLIANCEDEFENDINGFREEDOM,
  name: 'Alliance Defending Freedom',
  category: 'company',
})
@Injectable()
export class AlliancedefendingfreedomService implements IScraper {
  private readonly logger = new Logger(AlliancedefendingfreedomService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Alliance Defending Freedom: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10: defensive trim of wire title padding.
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
        const id = `alliancedefendingfreedom-${jobId}`;

        const locationStr = listing.location?.name ?? null;
        const location = locationStr
          ? new LocationDto({ city: locationStr })
          : null;

        if (input.location && locationStr) {
          if (!locationStr.toLowerCase().includes(input.location.toLowerCase())) continue;
        }

        // D-11: defensive trim of wire department padding.
        const deptRaw = listing.departments?.[0]?.name ?? null;
        const department = deptRaw ? deptRaw.trim() : null;

        jobs.push(
          new JobPostDto({
            id,
            site: Site.ALLIANCEDEFENDINGFREEDOM,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'Alliance Defending Freedom',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/alliancedefendingfreedom/jobs/${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            department,
          }),
        );
      }

      this.logger.log(`Alliance Defending Freedom: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Alliance Defending Freedom scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
