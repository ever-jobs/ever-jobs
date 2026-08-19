import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * AST SpaceMobile — AST SpaceMobile is a satellite communications company building a space-based cellular broadband network designed to connect everyday, unmodified mobile phones directly to satellites..
 *
 * AST SpaceMobile is a publicly traded company (Nasdaq: ASTS)
 * developing a constellation of low Earth orbit satellites that
 * provide direct-to-device cellular broadband connectivity to
 * standard, unmodified smartphones. Its satellites use large
 * phased-array antennas (the BlueWalker and BlueBird series) to
 * deliver space-based mobile service in partnership with terrestrial
 * wireless carriers. The company designs, assembles, and tests its
 * satellites and related hardware at facilities in Midland, Texas, and
 * works with mobile network operators worldwide to extend coverage to
 * areas without reliable cellular service.
 *
 * Sector: Space / Satellite Telecommunications. HQ: Midland, Texas, United States.
 *
 * Highlights:
 *   - Space-based direct-to-cell broadband for unmodified mobile
 *     phones
 *   - Headquartered in Midland, Texas, United States
 *   - Publicly traded on Nasdaq under ticker ASTS
 *   - Operates BlueWalker and BlueBird satellite programs with large
 *     phased-array antennas
 *   - In-house satellite design, assembly, and test operations in
 *     Midland
 *
 * Source profile (Spec 758):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/astspacemobile/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'AST SpaceMobile'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 223 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/astspacemobile/jobs';

@SourcePlugin({
  site: Site.AST_SPACEMOBILE,
  name: 'AST SpaceMobile',
  category: 'company',
})
@Injectable()
export class ASTSpaceMobileService implements IScraper {
  private readonly logger = new Logger(ASTSpaceMobileService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`AST SpaceMobile: fetching ${url}`);

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
        const id = `astspacemobile-${jobId}`;

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
            site: Site.AST_SPACEMOBILE,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'AST SpaceMobile',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/astspacemobile/jobs/${listing.id}`,
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

      this.logger.log(`AST SpaceMobile: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`AST SpaceMobile scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
