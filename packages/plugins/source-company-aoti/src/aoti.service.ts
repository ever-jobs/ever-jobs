import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * AOTI — Medical device company providing home-based Topical Wound Oxygen (TWO2) therapy for chronic wounds..
 *
 * AOTI (Advanced Oxygen Therapy Inc.) is a privately owned medical
 * device company specializing in home-based wound care, best known for
 * its Topical Wound Oxygen (TWO2) therapy for chronic and hard-to-heal
 * wounds such as diabetic foot ulcers, venous leg ulcers, and pressure
 * injuries. The company markets its therapy through a US field sales
 * force organized into regional territories and supports patient
 * access via payer and Medicaid operations. AOTI maintains operations
 * in the United States (Oceanside, California) and a manufacturing
 * presence in Galway, Ireland.
 *
 * Sector: Medical Devices / Wound Care. HQ: Oceanside, California, USA.
 *
 * Highlights:
 *   - Develops Topical Wound Oxygen (TWO2) therapy for diabetic foot
 *     ulcers, venous leg ulcers, and pressure injuries
 *   - Hires 1099 medical sales representatives across US regional
 *     territories (Northeast, Mid-Atlantic, South Central, West,
 *     Central)
 *   - Operates a dedicated Medicaid Operations function for payer and
 *     patient access
 *   - US operations in Oceanside, California with manufacturing in
 *     Galway, Ireland
 *   - Privately owned medical device company focused on home-based
 *     chronic wound care
 *
 * Source profile (Spec 276):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/aoti/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'AOTI'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 17 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/aoti/jobs';

@SourcePlugin({
  site: Site.AOTI,
  name: 'AOTI',
  category: 'company',
})
@Injectable()
export class AotiService implements IScraper {
  private readonly logger = new Logger(AotiService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`AOTI: fetching ${url}`);

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
        const id = `aoti-${jobId}`;

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
            site: Site.AOTI,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'AOTI',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/aoti/jobs/${listing.id}`,
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

      this.logger.log(`AOTI: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`AOTI scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
