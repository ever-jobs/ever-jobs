import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * AlphaSense — AI-powered market intelligence and document search platform for financial and corporate research..
 *
 * AlphaSense is a market intelligence and search platform that helps
 * businesses and financial professionals find, analyze, and monitor
 * information across documents such as company filings, earnings
 * transcripts, broker research, news, and expert call transcripts. The
 * product applies AI and natural language search across both public
 * and proprietary content sources to surface relevant insights. The
 * company serves financial services firms and corporations, and its
 * 2024 acquisition of Tegus expanded its expert-insights and
 * primary-research offerings.
 *
 * Sector: Market Intelligence / Financial Technology Software. HQ: New York, New York, United States.
 *
 * Highlights:
 *   - Hiring across Financial Services Sales, Corporate Sales, and
 *     Customer Success, indicating a B2B SaaS sales motion targeting
 *     financial firms and enterprises
 *   - Expert Insights department aligns with its primary-research and
 *     expert-call content offering
 *   - Multi-region footprint with roles in New York, London, Pune, and
 *     Delhi alongside US-remote positions
 *   - Sales roles span enterprise and corporate segments, including
 *     Enterprise Intelligence and existing-business account management
 *
 * Source profile (Spec 243):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/alphasense/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'AlphaSense'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 214 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/alphasense/jobs';

@SourcePlugin({
  site: Site.ALPHASENSE,
  name: 'AlphaSense',
  category: 'company',
})
@Injectable()
export class AlphasenseService implements IScraper {
  private readonly logger = new Logger(AlphasenseService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`AlphaSense: fetching ${url}`);

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
        const id = `alphasense-${jobId}`;

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
            site: Site.ALPHASENSE,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'AlphaSense',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/alphasense/jobs/${listing.id}`,
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

      this.logger.log(`AlphaSense: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`AlphaSense scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
