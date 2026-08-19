import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * SambaNova Systems — SambaNova Systems builds AI chips, dataflow hardware systems, and a full-stack platform for running and deploying large AI models..
 *
 * SambaNova Systems is an American technology company that designs
 * purpose-built AI hardware and an integrated software platform for
 * training and running large-scale machine learning and generative AI
 * models. Its core technology centers on a reconfigurable dataflow
 * architecture, delivered as integrated systems and as a
 * cloud/enterprise service for deploying foundation models. The
 * company serves enterprises, government, and research organizations
 * that need high-performance AI inference and training infrastructure.
 * Its hiring spans hardware, manufacturing test, cloud reliability,
 * and systems engineering, consistent with a vertically integrated
 * chips-to-systems business.
 *
 * Sector: AI Hardware / Semiconductors. HQ: San Jose, California, United States.
 *
 * Highlights:
 *   - Designs reconfigurable dataflow AI processors and integrated
 *     hardware systems
 *   - Offers a full-stack platform for training and serving
 *     large/foundation AI models
 *   - Headquartered in San Jose, California, in the heart of Silicon
 *     Valley
 *   - Hiring spans chip/hardware, manufacturing test, and cloud site
 *     reliability roles
 *   - Serves enterprise, government, and research customers deploying
 *     large-scale AI
 *
 * Source profile (Spec 784):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/sambanovasystems/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'SambaNova Systems'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 19 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/sambanovasystems/jobs';

@SourcePlugin({
  site: Site.SAMBANOVA_SYSTEMS,
  name: 'SambaNova Systems',
  category: 'company',
})
@Injectable()
export class SambaNovaSystemsService implements IScraper {
  private readonly logger = new Logger(SambaNovaSystemsService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`SambaNova Systems: fetching ${url}`);

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
        const id = `sambanovasystems-${jobId}`;

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
            site: Site.SAMBANOVA_SYSTEMS,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'SambaNova Systems',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/sambanovasystems/jobs/${listing.id}`,
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

      this.logger.log(`SambaNova Systems: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`SambaNova Systems scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
