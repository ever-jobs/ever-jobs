import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * American Institutes for Research — Nonprofit applied research and evaluation organization in social and behavioral science..
 *
 * American Institutes for Research (AIR) is a nonpartisan,
 * not-for-profit behavioral and social science research and evaluation
 * organization founded in 1946. It conducts applied research,
 * evaluation, and technical assistance across domains including
 * education, health, human and community development, and workforce
 * systems, often for government and public-sector clients. The
 * organization is headquartered in Arlington, Virginia, and operates
 * from additional US offices alongside remote staff.
 *
 * Sector: Social and behavioral science research and evaluation (nonprofit). HQ: Arlington, Virginia, United States.
 *
 * Highlights:
 *   - Nonpartisan, not-for-profit research and evaluation organization
 *     founded in 1946
 *   - Research programs span healthcare innovations, education systems
 *     and policy, learning supports, and human and community
 *     development
 *   - Hires research and analytical roles such as economists,
 *     directors, and AI strategists
 *   - Operates across multiple US locations (VA, NC, IL, CA, TX) with
 *     substantial remote-eligible roles
 *
 * Source profile (Spec 262):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/americaninstitutesforresearch/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'American Institutes for Research'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 22 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/americaninstitutesforresearch/jobs';

@SourcePlugin({
  site: Site.AMERICANINSTITUTESFORRESEARCH,
  name: 'American Institutes for Research',
  category: 'company',
})
@Injectable()
export class AmericaninstitutesforresearchService implements IScraper {
  private readonly logger = new Logger(AmericaninstitutesforresearchService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`American Institutes for Research: fetching ${url}`);

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
        const id = `americaninstitutesforresearch-${jobId}`;

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
            site: Site.AMERICANINSTITUTESFORRESEARCH,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'American Institutes for Research',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/americaninstitutesforresearch/jobs/${listing.id}`,
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

      this.logger.log(`American Institutes for Research: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`American Institutes for Research scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
