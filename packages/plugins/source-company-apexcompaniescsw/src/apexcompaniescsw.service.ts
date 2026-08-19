import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Apex Companies - CSW — Stormwater inspection, maintenance, erosion control, and environmental compliance services..
 *
 * Apex Companies is a national environmental, water, and compliance
 * services firm; this "CSW" unit covers its stormwater operations,
 * largely built around Storm Water Inspection & Maintenance Services
 * (SWIMS), a California-based provider Apex acquired. The group
 * performs stormwater inspection and maintenance, erosion control,
 * dewatering, and related construction and regulatory compliance work.
 * Hiring spans field and operational roles such as response managers,
 * foremen, and laborer/technician/driver positions across departments
 * tied to its CSW and SWIMS lines.
 *
 * Sector: Environmental and stormwater compliance services. HQ: Rockville, MD, USA.
 *
 * Highlights:
 *   - Stormwater inspection, maintenance, and compliance operations
 *     under the CSW/SWIMS unit
 *   - Field trades including erosion control foremen and
 *     laborer/technician/driver roles
 *   - Emergency stormwater response and repair capabilities
 *   - Operates across CA (Livermore, Jurupa Valley, San Juan
 *     Capistrano), KS (Wichita), and AZ (Phoenix), plus remote roles
 *   - SWIMS line acquired by Apex to extend its national stormwater
 *     platform
 *
 * Source profile (Spec 282):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/apexcompaniescsw/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'Apex Companies - CSW'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 46 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/apexcompaniescsw/jobs';

@SourcePlugin({
  site: Site.APEXCOMPANIESCSW,
  name: 'Apex Companies - CSW',
  category: 'company',
})
@Injectable()
export class ApexcompaniescswService implements IScraper {
  private readonly logger = new Logger(ApexcompaniescswService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Apex Companies - CSW: fetching ${url}`);

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
        const id = `apexcompaniescsw-${jobId}`;

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
            site: Site.APEXCOMPANIESCSW,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'Apex Companies - CSW',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/apexcompaniescsw/jobs/${listing.id}`,
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

      this.logger.log(`Apex Companies - CSW: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Apex Companies - CSW scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
