import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Gravity R&D — Gravity R&D builds AI-powered recommendation and personalization technology that delivers personalized product, content, and ad recommendations for retail, e-commerce, and digital media..
 *
 * Gravity R&D is a Budapest-headquartered software vendor specializing
 * in recommender systems and personalization, founded in 2007 by
 * members of the engineering team that tied for first in the Netflix
 * Prize recommendation competition. Its core product is the Yusp
 * recommendation engine, which uses proprietary deep-learning
 * algorithms over contextual and first-party data to power
 * personalized recommendations and dynamic ads for retail, e-commerce,
 * and digital media customers. The company also has an office in Győr,
 * Hungary and a subsidiary in Japan, and was acquired in 2022 to
 * become an R&D hub for its parent. (This entry describes the
 * Greenhouse board "gravity" / board name "Gravity," whose
 * Budapest-based roles such as "Senior Business Analyst (Dynamic Ads)"
 * and "Junior Software Engineer" match Gravity R&D.)
 *
 * Sector: AdTech / Recommendation & Personalization Software. HQ: Budapest, Hungary.
 *
 * Highlights:
 *   - Founded in 2007 in Budapest by members of the team that tied for
 *     first in the Netflix Prize recommendation competition
 *   - Core product is the Yusp recommendation engine, built on
 *     proprietary deep-learning algorithms
 *   - Powers personalized recommendations and dynamic ads for retail,
 *     e-commerce, and digital media clients
 *   - Serves customers in 20+ countries, delivering tens of billions
 *     of recommendations per month
 *   - Headquartered in Budapest with an office in Győr, Hungary and a
 *     subsidiary in Japan; acquired by Taboola in 2022
 *
 * Source profile (Spec 794):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/gravity/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'Gravity R&D'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 4 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/gravity/jobs';

@SourcePlugin({
  site: Site.GRAVITY_R_D,
  name: 'Gravity R&D',
  category: 'company',
})
@Injectable()
export class GravityRDService implements IScraper {
  private readonly logger = new Logger(GravityRDService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Gravity R&D: fetching ${url}`);

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
        const id = `gravity-${jobId}`;

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
            site: Site.GRAVITY_R_D,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'Gravity R&D',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/gravity/jobs/${listing.id}`,
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

      this.logger.log(`Gravity R&D: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Gravity R&D scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
