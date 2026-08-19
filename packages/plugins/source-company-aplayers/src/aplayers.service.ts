import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * MrBeast Contract Jobs — Contract and freelance hiring channel for the MrBeast creator-media and content production operation..
 *
 * MrBeast Contract Jobs is the contract and freelance hiring channel
 * for the media and entertainment operation associated with creator
 * Jimmy Donaldson (MrBeast), which produces high-volume online video
 * content and related brand and commerce ventures. Postings cover
 * content production support such as subtitling and transcription,
 * creative ideation, brand partnerships, and studio management,
 * indicating a focus on staffing for global content creation and
 * distribution. Roles are largely remote and offered on freelance or
 * fixed-term contract terms across multiple regions, including APAC
 * and North Carolina.
 *
 * Sector: Media and Entertainment / Digital Content Creation. HQ: Greenville, NC, USA.
 *
 * Highlights:
 *   - Hires contract and freelance talent for online video content
 *     production and supporting operations
 *   - Roles span content localization (subtitling, transcription),
 *     creative ideation, and brand partnerships
 *   - Departments include Creator Global Platform, Creative, Revenue /
 *     Brand Partnerships, and Studio Management
 *   - Positions are predominantly remote with regional postings across
 *     APAC and North Carolina
 *
 * Source profile (Spec 285):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/aplayers/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'MrBeast Contract Jobs'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 11 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/aplayers/jobs';

@SourcePlugin({
  site: Site.APLAYERS,
  name: 'MrBeast Contract Jobs',
  category: 'company',
})
@Injectable()
export class AplayersService implements IScraper {
  private readonly logger = new Logger(AplayersService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`MrBeast Contract Jobs: fetching ${url}`);

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
        const id = `aplayers-${jobId}`;

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
            site: Site.APLAYERS,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'MrBeast Contract Jobs',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/aplayers/jobs/${listing.id}`,
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

      this.logger.log(`MrBeast Contract Jobs: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`MrBeast Contract Jobs scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
