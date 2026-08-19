import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Amtech Software — ERP and MES software for corrugated, folding carton, and label packaging manufacturers..
 *
 * Amtech Software is an enterprise software provider serving the
 * packaging manufacturing industry, with ERP and manufacturing
 * execution system (MES) products built for corrugated, folding
 * carton, and label producers. Founded in 1981 and headquartered in
 * Fort Washington, Pennsylvania, its platform spans estimating,
 * planning, production, inventory, purchasing, and plant-floor
 * execution. The hiring footprint across India, the United Kingdom,
 * and the United States, with roles in technology, product, marketing,
 * customer operations, application support, and network services,
 * reflects a globally distributed software and support organization.
 *
 * Sector: Enterprise software (manufacturing ERP/MES for packaging). HQ: Fort Washington, Pennsylvania, United States.
 *
 * Highlights:
 *   - Industry-specific ERP/MES platform for the packaging sector
 *     (corrugated, folding carton, labels)
 *   - Operating since 1981 with deep vertical focus on packaging
 *     manufacturing
 *   - Product suite includes EnCore and Axiom ERP covering estimating
 *     through plant-floor execution
 *   - Distributed hiring across India, the UK, and the US spanning
 *     engineering, product, support, and operations
 *   - Cloud and infrastructure roles (Cloud Architect, Network
 *     Services) indicate cloud-oriented delivery
 *
 * Source profile (Spec 264):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/amtechsoftware/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'Amtech Software'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 12 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/amtechsoftware/jobs';

@SourcePlugin({
  site: Site.AMTECHSOFTWARE,
  name: 'Amtech Software',
  category: 'company',
})
@Injectable()
export class AmtechsoftwareService implements IScraper {
  private readonly logger = new Logger(AmtechsoftwareService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Amtech Software: fetching ${url}`);

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
        const id = `amtechsoftware-${jobId}`;

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
            site: Site.AMTECHSOFTWARE,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'Amtech Software',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/amtechsoftware/jobs/${listing.id}`,
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

      this.logger.log(`Amtech Software: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Amtech Software scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
