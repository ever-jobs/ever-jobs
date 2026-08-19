import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Anteris Technologies — Structural heart medical device company developing the DurAVR biomimetic transcatheter aortic valve..
 *
 * Anteris Technologies (Anteris Technologies Global Corp.; NASDAQ/ASX:
 * AVR) is a structural heart medical device company developing
 * transcatheter heart valve technology for the treatment of aortic
 * stenosis. Its lead product is the DurAVR transcatheter heart valve,
 * a biomimetic, balloon-expandable valve built from its patented ADAPT
 * anti-calcification tissue, currently in clinical trials and not yet
 * approved for commercial sale. Founded in Australia, the company
 * maintains significant operations in the Minneapolis, Minnesota area
 * along with sites in Europe and Australia. Hiring spans clinical and
 * regulatory affairs, quality, R&D, tech operations, and corporate
 * functions.
 *
 * Sector: Medical Devices (Structural Heart / Cardiovascular). HQ: Minneapolis, Minnesota, United States (founded in Australia).
 *
 * Highlights:
 *   - Lead product: DurAVR transcatheter heart valve (THV), a
 *     single-piece biomimetic, balloon-expandable valve for aortic
 *     stenosis
 *   - Proprietary ADAPT anti-calcification bovine tissue technology
 *     and ComASUR delivery system
 *   - Dual-listed on NASDAQ and ASX under ticker AVR; founded in
 *     Australia with a major presence in Minneapolis
 *   - Devices are investigational and in clinical trials (e.g., the
 *     global pivotal PARADIGM Trial), not yet cleared for commercial
 *     sale
 *   - Hiring across Clinical, Regulatory, Quality, R&D, Tech Ops, and
 *     Corporate functions, with sites in Minnesota, Geneva, Australia,
 *     and remote EU
 *
 * Source profile (Spec 274):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/anteristech/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'Anteris Technologies'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 10 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/anteristech/jobs';

@SourcePlugin({
  site: Site.ANTERISTECH,
  name: 'Anteris Technologies',
  category: 'company',
})
@Injectable()
export class AnteristechService implements IScraper {
  private readonly logger = new Logger(AnteristechService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Anteris Technologies: fetching ${url}`);

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
        const id = `anteristech-${jobId}`;

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
            site: Site.ANTERISTECH,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'Anteris Technologies',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/anteristech/jobs/${listing.id}`,
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

      this.logger.log(`Anteris Technologies: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Anteris Technologies scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
