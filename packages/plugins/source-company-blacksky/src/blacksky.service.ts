import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * BlackSky Technology — BlackSky is a geospatial intelligence company that operates a constellation of small Earth-observation satellites and delivers real-time imagery and analytics..
 *
 * BlackSky Technology Inc. is a space-based geospatial intelligence
 * provider that owns and operates a constellation of low-Earth-orbit
 * small satellites for high-revisit Earth observation. The company
 * delivers on-demand satellite imagery, monitoring, and AI-driven
 * analytics to government and commercial customers through its Spectra
 * software platform. BlackSky is headquartered in Herndon, Virginia,
 * with satellite design, assembly, and integration operations in the
 * Seattle area (including Tukwila, Washington). It is publicly traded
 * on the New York Stock Exchange.
 *
 * Sector: SpaceTech / Geospatial Intelligence. HQ: Herndon, Virginia, USA.
 *
 * Highlights:
 *   - Sector: space-based geospatial intelligence and Earth
 *     observation
 *   - HQ: Herndon, Virginia, USA; satellite operations in the
 *     Seattle/Tukwila, WA area
 *   - Operates a constellation of low-Earth-orbit small satellites for
 *     high-revisit imaging
 *   - Spectra software platform for on-demand imagery, monitoring, and
 *     AI analytics
 *   - Serves government and commercial customers; publicly traded
 *     (NYSE)
 *
 * Source profile (Spec 759):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/blacksky/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'BlackSky Technology'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 31 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/blacksky/jobs';

@SourcePlugin({
  site: Site.BLACKSKY_TECHNOLOGY,
  name: 'BlackSky Technology',
  category: 'company',
})
@Injectable()
export class BlackSkyTechnologyService implements IScraper {
  private readonly logger = new Logger(BlackSkyTechnologyService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`BlackSky Technology: fetching ${url}`);

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
        const id = `blacksky-${jobId}`;

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
            site: Site.BLACKSKY_TECHNOLOGY,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'BlackSky Technology',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/blacksky/jobs/${listing.id}`,
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

      this.logger.log(`BlackSky Technology: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`BlackSky Technology scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
