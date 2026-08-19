import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * AI Squared — Platform for embedding AI and machine-learning models into existing business applications..
 *
 * AI Squared is a Washington, DC-based software company, founded in
 * 2019, that builds a platform for integrating AI and machine-learning
 * models into existing web-based business applications. Its tooling
 * lets data science teams operationalize models and surface insights
 * directly inside the workflows and applications business users
 * already use. The company sells to enterprise, federal/government,
 * and mid-market customers, and has raised venture funding including a
 * seed round and a Series A.
 *
 * Sector: Enterprise AI / Machine Learning Software. HQ: Washington, DC, USA.
 *
 * Highlights:
 *   - Platform integrates AI/ML models and insights into existing
 *     web-based business applications
 *   - Serves enterprise, federal/government, and mid-market segments
 *   - Founded in 2019; headquartered in Washington, DC with
 *     engineering presence in India (Bangalore)
 *   - Venture-backed (seed and Series A funding rounds)
 *   - Hiring across Sales (Enterprise, Federal, Mid Market) and
 *     Engineering
 *
 * Source profile (Spec 220):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/aisquared/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'AI Squared'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 8 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/aisquared/jobs';

@SourcePlugin({
  site: Site.AISQUARED,
  name: 'AI Squared',
  category: 'company',
})
@Injectable()
export class AisquaredService implements IScraper {
  private readonly logger = new Logger(AisquaredService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`AI Squared: fetching ${url}`);

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
        const id = `aisquared-${jobId}`;

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
            site: Site.AISQUARED,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'AI Squared',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/aisquared/jobs/${listing.id}`,
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

      this.logger.log(`AI Squared: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`AI Squared scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
