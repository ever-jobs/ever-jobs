import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * AIFT — Asia-based AI security and insurtech group (formerly OneDegree), behind Cymetrics, Vulcan, and a virtual insurer..
 *
 * AIFT (AI Financial Technology) is an Asia-based technology group,
 * founded in 2016 and historically known by the trading name of its
 * insurance arm, OneDegree. The group operates across AI security and
 * insurtech, with brands including Cymetrics and its Vulcan AI/LLM
 * security testing platform, plus OneDegree, a licensed virtual
 * insurer in Hong Kong. Engineering and operations roles span Taiwan
 * and Hong Kong, with a broader regional presence including Singapore,
 * South Korea, Japan, and the UAE.
 *
 * Sector: AI security & insurtech. HQ: Hong Kong (with Taiwan operations).
 *
 * Highlights:
 *   - Rebranded from OneDegree Group to AIFT, reflecting a focus on AI
 *     and cybersecurity
 *   - Runs the Vulcan platform for AI/LLM red-teaming and Responsible
 *     AI compliance testing
 *   - Includes OneDegree, a licensed virtual (digital) insurer
 *     operating in Hong Kong
 *   - Regional footprint across Taiwan, Hong Kong, Singapore, South
 *     Korea, Japan, and the UAE
 *   - Hiring across AI security research, ODHK engineering, business
 *     development, and operations
 *
 * Source profile (Spec 213):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/aift/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'AIFT'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 38 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/aift/jobs';

@SourcePlugin({
  site: Site.AIFT,
  name: 'AIFT',
  category: 'company',
})
@Injectable()
export class AiftService implements IScraper {
  private readonly logger = new Logger(AiftService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`AIFT: fetching ${url}`);

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
        const id = `aift-${jobId}`;

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
            site: Site.AIFT,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'AIFT',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/aift/jobs/${listing.id}`,
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

      this.logger.log(`AIFT: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`AIFT scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
