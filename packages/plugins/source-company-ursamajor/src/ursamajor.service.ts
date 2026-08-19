import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Ursa Major — Ursa Major designs and manufactures advanced rocket engines and propulsion systems for space launch, hypersonics, and missile/defense applications..
 *
 * Ursa Major (legally Ursa Major Technologies) is an American
 * aerospace company founded in 2015 by Joe Laurienti, a former SpaceX
 * and Blue Origin propulsion engineer. It positions itself as an
 * independent supplier of advanced, additively-manufactured rocket
 * engines and solid rocket motors for space launch, hypersonic
 * vehicles, and missile/defense systems. Its flagship products include
 * the Hadley and Ripley liquid-fuel engines. The careers board
 * location (Berthoud, Colorado) and sample roles (Chief Engineer,
 * Vehicle; Buyer II; Accounts Payable Coordinator II) are consistent
 * with a Colorado-based hardware/manufacturing aerospace company.
 *
 * Sector: Aerospace & Defense / Rocket Propulsion. HQ: Berthoud, Colorado, USA.
 *
 * Highlights:
 *   - Founded in 2015 by Joe Laurienti (ex-SpaceX, ex-Blue Origin);
 *     headquartered in Berthoud, Colorado
 *   - Develops liquid-fuel rocket engines (Hadley ~5,000 lbf, Ripley)
 *     using oxygen-rich staged combustion and 3D-printed (additive)
 *     manufacturing
 *   - Serves space launch, hypersonics, and missile/defense propulsion
 *     markets; markets itself as an independent U.S. engine supplier
 *   - Hadley engine achieved flight and qualified for both hypersonic
 *     and space-launch applications
 *   - Customer base spans commercial space and government/defense
 *     programs
 *
 * Source profile (Spec 801):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/ursamajor/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'Ursa Major'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 43 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/ursamajor/jobs';

@SourcePlugin({
  site: Site.URSA_MAJOR,
  name: 'Ursa Major',
  category: 'company',
})
@Injectable()
export class UrsaMajorService implements IScraper {
  private readonly logger = new Logger(UrsaMajorService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Ursa Major: fetching ${url}`);

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
        const id = `ursamajor-${jobId}`;

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
            site: Site.URSA_MAJOR,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'Ursa Major',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/ursamajor/jobs/${listing.id}`,
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

      this.logger.log(`Ursa Major: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Ursa Major scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
