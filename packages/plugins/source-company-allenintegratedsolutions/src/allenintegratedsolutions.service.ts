import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Allen Integrated Solutions — Woman- and veteran-owned federal contractor delivering GEOINT, engineering, and intelligence-mission support..
 *
 * Allen Integrated Solutions LLC (AIS) is a U.S. federal government
 * services contractor providing engineering, analytics, and
 * operational support to the Intelligence Community and Department of
 * Defense, with a focus on geospatial intelligence (GEOINT), systems
 * engineering and integration, multi-intelligence analysis, and
 * mission operations. It is a woman-owned and veteran-owned small
 * business that supports the National Geospatial-Intelligence Agency
 * (NGA) and related national-security customers. Open roles (e.g.,
 * Business Analyst positions tied to FISMA auditing and commercial
 * GEOINT systems) and hiring locations clustered around NGA and IC
 * sites in Virginia, Missouri, Maryland, and Washington, D.C. are
 * consistent with this mission profile.
 *
 * Sector: Government Services / Defense & Intelligence Contracting. HQ: Stafford, Virginia, United States.
 *
 * Highlights:
 *   - Focuses on geospatial intelligence (GEOINT), systems
 *     engineering, and multi-intelligence analysis for IC and DoD
 *     customers
 *   - Supports the National Geospatial-Intelligence Agency (NGA) and
 *     broader Intelligence Community
 *   - Woman-owned and veteran-owned small business
 *   - Roles span federal compliance (FISMA audit) and commercial
 *     GEOINT systems analysis
 *   - Hiring concentrated near NGA/IC sites: Springfield VA, St. Louis
 *     MO, Chantilly VA, Annapolis Junction MD, Charlottesville VA, and
 *     Washington DC
 *
 * Source profile (Spec 234):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/allenintegratedsolutions/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'Allen Integrated Solutions'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 54 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/allenintegratedsolutions/jobs';

@SourcePlugin({
  site: Site.ALLENINTEGRATEDSOLUTIONS,
  name: 'Allen Integrated Solutions',
  category: 'company',
})
@Injectable()
export class AllenintegratedsolutionsService implements IScraper {
  private readonly logger = new Logger(AllenintegratedsolutionsService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Allen Integrated Solutions: fetching ${url}`);

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
        const id = `allenintegratedsolutions-${jobId}`;

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
            site: Site.ALLENINTEGRATEDSOLUTIONS,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'Allen Integrated Solutions',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/allenintegratedsolutions/jobs/${listing.id}`,
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

      this.logger.log(`Allen Integrated Solutions: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Allen Integrated Solutions scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
