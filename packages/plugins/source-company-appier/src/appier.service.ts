import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Appier — Taiwan-based company building AI-driven advertising and marketing software for the Asia-Pacific region..
 *
 * Appier is a Taiwan-based software company, founded in 2012, that
 * develops AI-driven advertising (AdTech) and marketing (MarTech)
 * software used by businesses to acquire, engage, and retain
 * customers. It is publicly traded on the Tokyo Stock Exchange (ticker
 * 4180) and operates across multiple Asia-Pacific markets, including
 * Taiwan, Japan, South Korea, China, and Vietnam. Its work spans
 * machine learning research, campaign management, and account-managed
 * advertising solutions.
 *
 * Sector: AI advertising and marketing technology (AdTech/MarTech). HQ: Taipei, Taiwan.
 *
 * Highlights:
 *   - Founded in 2012 and headquartered in Taipei, Taiwan
 *   - Publicly listed on the Tokyo Stock Exchange (ticker 4180)
 *   - Builds AI-driven AdTech and MarTech products spanning user
 *     acquisition, engagement, conversion, and retention
 *   - Operates across multiple Asia-Pacific markets including Taiwan,
 *     Japan, South Korea, China, and Vietnam
 *   - Hiring spans engineering, data science, campaign management, and
 *     advertising-solutions account management
 *
 * Source profile (Spec 293):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/appier/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'Appier'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 80 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/appier/jobs';

@SourcePlugin({
  site: Site.APPIER,
  name: 'Appier',
  category: 'company',
})
@Injectable()
export class AppierService implements IScraper {
  private readonly logger = new Logger(AppierService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Appier: fetching ${url}`);

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
        const id = `appier-${jobId}`;

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
            site: Site.APPIER,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'Appier',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/appier/jobs/${listing.id}`,
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

      this.logger.log(`Appier: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Appier scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
