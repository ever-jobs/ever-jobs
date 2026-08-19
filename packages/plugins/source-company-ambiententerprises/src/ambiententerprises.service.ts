import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Ambient Enterprises — National commercial HVAC platform uniting regional design, sales, and service firms..
 *
 * Ambient Enterprises is a national commercial HVAC platform that
 * operates as a collective of regional heating, ventilation, and
 * air-conditioning design, sales, and service firms serving
 * healthcare, commercial, institutional, and mission-critical
 * facilities. Its portfolio brands provide air-systems design,
 * equipment sales, installation, retrofit, parts, and ongoing
 * maintenance across the full building HVAC lifecycle. The company has
 * grown by acquiring and integrating established regional contractors,
 * maintaining offices across multiple U.S. states. Hiring spans
 * corporate functions (finance, administration) and field operations
 * (service, sales, parts) consistent with a multi-location services
 * business.
 *
 * Sector: Commercial HVAC services. HQ: Unknown.
 *
 * Highlights:
 *   - Collective of regional commercial HVAC design, sales, and
 *     service companies
 *   - Serves healthcare, commercial, institutional, and
 *     mission-critical facilities
 *   - Operates across multiple U.S. locations including CA, OH, PA,
 *     and WA
 *   - Covers the full HVAC lifecycle: design, equipment sales,
 *     installation, retrofit, parts, and maintenance
 *   - Grown through acquisition and integration of established
 *     regional contractors
 *
 * Source profile (Spec 257):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/ambiententerprises/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'Ambient Enterprises'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 86 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/ambiententerprises/jobs';

@SourcePlugin({
  site: Site.AMBIENTENTERPRISES,
  name: 'Ambient Enterprises',
  category: 'company',
})
@Injectable()
export class AmbiententerprisesService implements IScraper {
  private readonly logger = new Logger(AmbiententerprisesService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Ambient Enterprises: fetching ${url}`);

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
        const id = `ambiententerprises-${jobId}`;

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
            site: Site.AMBIENTENTERPRISES,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'Ambient Enterprises',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/ambiententerprises/jobs/${listing.id}`,
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

      this.logger.log(`Ambient Enterprises: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Ambient Enterprises scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
