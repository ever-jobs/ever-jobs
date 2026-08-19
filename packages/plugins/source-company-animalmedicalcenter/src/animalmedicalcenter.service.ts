import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Schwarzman Animal Medical Center — Nonprofit veterinary specialty hospital and teaching center in New York City..
 *
 * The Schwarzman Animal Medical Center (AMC), formerly the Animal
 * Medical Center, is a nonprofit veterinary hospital and teaching
 * hospital in New York City, founded in 1910. It provides emergency,
 * urgent, and specialty care across numerous clinical disciplines and
 * trains veterinarians through postgraduate education programs. The
 * organization was renamed following a major gift from Stephen and
 * Christine Schwarzman and operates from its Manhattan facility at 510
 * East 62nd Street.
 *
 * Sector: Veterinary healthcare. HQ: New York, NY, USA.
 *
 * Highlights:
 *   - Nonprofit veterinary hospital founded in 1910, based in
 *     Manhattan (510 East 62nd Street)
 *   - Operates as a veterinary teaching hospital with postgraduate
 *     clinical education programs
 *   - Offers multi-specialty care including dentistry and oral surgery
 *   - Hiring spans client services, care coordination, and
 *     clinical/veterinary support roles
 *   - Renamed Schwarzman Animal Medical Center following a major donor
 *     gift
 *
 * Source profile (Spec 269):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/animalmedicalcenter/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'Schwarzman Animal Medical Center'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 40 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/animalmedicalcenter/jobs';

@SourcePlugin({
  site: Site.ANIMALMEDICALCENTER,
  name: 'Schwarzman Animal Medical Center',
  category: 'company',
})
@Injectable()
export class AnimalmedicalcenterService implements IScraper {
  private readonly logger = new Logger(AnimalmedicalcenterService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Schwarzman Animal Medical Center: fetching ${url}`);

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
        const id = `animalmedicalcenter-${jobId}`;

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
            site: Site.ANIMALMEDICALCENTER,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'Schwarzman Animal Medical Center',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/animalmedicalcenter/jobs/${listing.id}`,
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

      this.logger.log(`Schwarzman Animal Medical Center: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Schwarzman Animal Medical Center scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
