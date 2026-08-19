import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Seurat Technologies — Metal additive manufacturer using laser Area Printing technology.
 *
 * Seurat Technologies is a metal additive manufacturing company that
 * produces industrial-scale parts using its proprietary Area Printing
 * process, which focuses roughly 2 million individually controllable
 * points of laser light onto a bed of metal powder. Founded on
 * technology developed at Lawrence Livermore National Laboratory and
 * spun out in 2015, the company offers contract manufacturing services
 * rather than selling printers. Its job openings span electro-optical
 * engineering, process engineering, and process technician roles tied
 * to its laser-based printing platform.
 *
 * Sector: Additive manufacturing (metal 3D printing). HQ: Wilmington, MA.
 *
 * Highlights:
 *   - Proprietary Area Printing process uses around 2 million
 *     controllable laser points on metal powder
 *   - Spun out of Lawrence Livermore National Laboratory with an
 *     exclusive technology license in 2015
 *   - Raised a $99M Series C led by NVIDIA's NVentures, with backers
 *     including Honda
 *
 * Source profile (Spec 631):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/seurat/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'Seurat Technologies'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 3 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/seurat/jobs';

@SourcePlugin({
  site: Site.SEURAT_TECHNOLOGIES,
  name: 'Seurat Technologies',
  category: 'company',
})
@Injectable()
export class SeuratTechnologiesService implements IScraper {
  private readonly logger = new Logger(SeuratTechnologiesService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Seurat Technologies: fetching ${url}`);

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
        const id = `seurat-${jobId}`;

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
            site: Site.SEURAT_TECHNOLOGIES,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'Seurat Technologies',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/seurat/jobs/${listing.id}`,
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

      this.logger.log(`Seurat Technologies: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Seurat Technologies scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
