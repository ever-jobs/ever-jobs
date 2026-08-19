import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Altos Labs — Biotechnology company researching cellular rejuvenation programming to reverse age-related disease and decline..
 *
 * Altos Labs is a biotechnology company founded in 2022 that
 * researches cellular rejuvenation programming, aiming to understand
 * and reverse the cellular processes underlying disease, injury, and
 * age-related decline. The company operates through multiple research
 * institutes spanning discovery science, computation, and drug
 * discovery, organized in part around individual
 * principal-investigator labs. It conducts work across sites in the
 * San Francisco Bay Area and San Diego in the United States and
 * Cambridge in the United Kingdom.
 *
 * Sector: Biotechnology / Life Sciences. HQ: San Francisco Bay Area, CA, USA.
 *
 * Highlights:
 *   - Focuses on cellular rejuvenation programming and the biology of
 *     aging and disease
 *   - Structured around research institutes including Discovery
 *     Science, Institute of Computation, and Drug Discovery &
 *     Development Science
 *   - Includes named principal-investigator groups such as the
 *     Belmonte Lab
 *   - Operates across the San Francisco Bay Area, San Diego, and
 *     Cambridge, UK
 *   - Hires across scientific research, computation/AI, and clinical
 *     and operational support roles
 *
 * Source profile (Spec 249):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/altoslabs/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'Altos Labs'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 26 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/altoslabs/jobs';

@SourcePlugin({
  site: Site.ALTOSLABS,
  name: 'Altos Labs',
  category: 'company',
})
@Injectable()
export class AltoslabsService implements IScraper {
  private readonly logger = new Logger(AltoslabsService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Altos Labs: fetching ${url}`);

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
        const id = `altoslabs-${jobId}`;

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
            site: Site.ALTOSLABS,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'Altos Labs',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/altoslabs/jobs/${listing.id}`,
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

      this.logger.log(`Altos Labs: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Altos Labs scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
