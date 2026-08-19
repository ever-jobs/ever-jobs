import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * AGE Solutions — Technology and professional services firm supporting U.S. government, defense, and intelligence programs..
 *
 * AGE Solutions LLC is a technology and professional services company
 * serving U.S. government, defense, and intelligence customers. Its
 * work spans network engineering, cloud computing, cybersecurity, and
 * enterprise audiovisual and video teleconferencing (AV/VTC) systems
 * delivered under federal contracts. Open roles for AV engineers,
 * cable technicians, and related field staff are concentrated at
 * military and government sites in the Washington, DC metro area and
 * around the country, where positions are often contingent on contract
 * award and government clearance.
 *
 * Sector: Government IT and professional services. HQ: Alexandria, VA, USA.
 *
 * Highlights:
 *   - Serves U.S. government, defense, and intelligence sector
 *     customers under federal contracts
 *   - Roles include AV/VTC engineers, AV engineers, and cable
 *     technicians within a Programs department
 *   - Hiring locations cluster around DC-area defense and intelligence
 *     sites: Fort Belvoir VA, Ft. Meade MD, Arlington VA, Washington
 *     DC, Alexandria VA, plus San Diego CA
 *   - Capabilities span network engineering, cloud computing,
 *     cybersecurity, and enterprise audiovisual/VTC systems
 *   - Many postings are clearance- and contract-award contingent,
 *     typical of federal government contracting
 *
 * Source profile (Spec 206):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/agecareers/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'AGE Solutions'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 61 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/agecareers/jobs';

@SourcePlugin({
  site: Site.AGECAREERS,
  name: 'AGE Solutions',
  category: 'company',
})
@Injectable()
export class AgecareersService implements IScraper {
  private readonly logger = new Logger(AgecareersService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`AGE Solutions: fetching ${url}`);

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
        const id = `agecareers-${jobId}`;

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
            site: Site.AGECAREERS,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'AGE Solutions',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/agecareers/jobs/${listing.id}`,
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

      this.logger.log(`AGE Solutions: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`AGE Solutions scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
