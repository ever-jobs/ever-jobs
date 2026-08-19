import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * AE Studio — Bootstrapped applied-AI and software studio pairing client product work with AI alignment research.
 *
 * AE Studio is a bootstrapped, independent applied-AI and software
 * development company founded in 2016 and based in Los Angeles,
 * California. It combines client-facing work building production AI
 * systems, data science, and software products with internally funded
 * research on AI alignment and safety. Its hiring spans data science,
 * research, and technical program management functions, with roles
 * based in Los Angeles and offered as US-remote.
 *
 * Sector: Artificial Intelligence / Software Development. HQ: Los Angeles, CA, USA.
 *
 * Highlights:
 *   - Founded in 2016; bootstrapped and independent with no outside
 *     (VC/PE) investors
 *   - Operates across two areas: applied AI/software consulting for
 *     clients and internally funded AI alignment research
 *   - Hiring in Data Science & Research functions, including AI
 *     alignment and applied AI data science roles
 *   - Roles based in Los Angeles, CA with US-remote options
 *   - Careers hosted on Greenhouse under the slug 'aestudio'
 *
 * Source profile (Spec 199):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/aestudio/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'AE Studio'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 6 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/aestudio/jobs';

@SourcePlugin({
  site: Site.AESTUDIO,
  name: 'AE Studio',
  category: 'company',
})
@Injectable()
export class AestudioService implements IScraper {
  private readonly logger = new Logger(AestudioService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`AE Studio: fetching ${url}`);

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
        const id = `aestudio-${jobId}`;

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
            site: Site.AESTUDIO,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'AE Studio',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/aestudio/jobs/${listing.id}`,
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

      this.logger.log(`AE Studio: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`AE Studio scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
