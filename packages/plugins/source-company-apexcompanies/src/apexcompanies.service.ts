import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Apex Companies — National environmental consulting and engineering firm covering water, remediation, and health and safety..
 *
 * Apex Companies, LLC is a U.S. environmental consulting and
 * engineering services firm founded in 1988 and headquartered in
 * Rockville, Maryland. Its work spans water resources, environmental
 * site assessment and remediation, industrial hygiene, health and
 * safety, compliance, and infrastructure services. The firm operates
 * across all 50 states through a network of regional offices and has
 * grown in part through acquisitions of smaller specialty
 * consultancies.
 *
 * Sector: Environmental Consulting & Engineering Services. HQ: Rockville, Maryland, USA.
 *
 * Highlights:
 *   - Hiring spans environmental and occupational specialties such as
 *     asbestos inspection, industrial hygiene, and project management
 *   - Organized into numbered regional departments covering the
 *     Mid-Atlantic, Rockies, South Atlantic, California, Appalachia,
 *     and Florida
 *   - Roles based across multiple U.S. metros (Lakewood CO, Manassas
 *     VA, Miami FL, Los Angeles CA, Iselin NJ, Fort Myers FL) plus
 *     remote positions
 *   - Service areas include water resources, environmental
 *     remediation, compliance, and health and safety consulting
 *   - Founded in 1988 with operations across all 50 states
 *
 * Source profile (Spec 281):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/apexcompanies/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'Apex Companies'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 226 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/apexcompanies/jobs';

@SourcePlugin({
  site: Site.APEXCOMPANIES,
  name: 'Apex Companies',
  category: 'company',
})
@Injectable()
export class ApexcompaniesService implements IScraper {
  private readonly logger = new Logger(ApexcompaniesService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Apex Companies: fetching ${url}`);

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
        const id = `apexcompanies-${jobId}`;

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
            site: Site.APEXCOMPANIES,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'Apex Companies',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/apexcompanies/jobs/${listing.id}`,
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

      this.logger.log(`Apex Companies: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Apex Companies scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
