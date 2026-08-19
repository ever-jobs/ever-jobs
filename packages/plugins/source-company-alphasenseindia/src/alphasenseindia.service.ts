import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * AlphaSense India — AI-powered market intelligence and search platform for business and financial research..
 *
 * AlphaSense is a market intelligence and search platform that uses AI
 * to help business and financial professionals search, summarize, and
 * monitor companies, industries, and topics across premium content,
 * filings, and research. Founded in 2011 and headquartered in New York
 * City, the company operates globally, with India teams hiring across
 * Bengaluru, Pune, Delhi, Mumbai, and remote roles. The Greenhouse
 * board for this entity lists openings in Customer Success,
 * Engineering, Compliance, Content, and Revenue Operations, including
 * customer and product support analyst positions.
 *
 * Sector: Market Intelligence / Financial Technology Software. HQ: New York City, USA.
 *
 * Highlights:
 *   - India operations span Bengaluru, Pune, Delhi, Mumbai, and remote
 *     roles
 *   - Hiring across Customer Success, Engineering, Compliance,
 *     Content, and Revenue Operations
 *   - AI search platform over premium business and financial content
 *   - Founded 2011; HQ in New York City with global offices
 *   - Open roles include customer and product support analyst
 *     positions
 *
 * Source profile (Spec 244):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/alphasenseindia/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'AlphaSense India'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 45 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/alphasenseindia/jobs';

@SourcePlugin({
  site: Site.ALPHASENSEINDIA,
  name: 'AlphaSense India',
  category: 'company',
})
@Injectable()
export class AlphasenseindiaService implements IScraper {
  private readonly logger = new Logger(AlphasenseindiaService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`AlphaSense India: fetching ${url}`);

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
        const id = `alphasenseindia-${jobId}`;

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
            site: Site.ALPHASENSEINDIA,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'AlphaSense India',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/alphasenseindia/jobs/${listing.id}`,
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

      this.logger.log(`AlphaSense India: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`AlphaSense India scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
