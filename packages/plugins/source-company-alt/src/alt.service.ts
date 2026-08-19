import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Alt — Marketplace and vaulting platform for buying, selling, and financing collectible trading cards..
 *
 * Alt (alt.xyz) operates an online marketplace for buying, selling,
 * vaulting, and financing collectible trading cards, with a focus on
 * graded sports cards and other alternative assets. The company runs a
 * physical Vault facility in Delaware where authenticated cards are
 * stored and insured, complementing its auction house, marketplace,
 * and portfolio-valuation tools. It was founded in 2020 and hires
 * across sales, customer experience, engineering, product, and design.
 *
 * Sector: Collectibles / Alternative-asset marketplace. HQ: San Francisco, California, USA.
 *
 * Highlights:
 *   - Online marketplace for graded trading cards and alternative
 *     collectible assets
 *   - Operates a physical Vault for storage, insurance, and
 *     authentication in Delaware
 *   - Vintage-focused account executive roles indicate a dedicated
 *     vintage card segment
 *   - Hiring across Sales, Customer Experience, Engineering,
 *     Operations, Design, and Product/Data
 *   - Founded in 2020
 *
 * Source profile (Spec 245):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/alt/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'Alt'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 13 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/alt/jobs';

@SourcePlugin({
  site: Site.ALT,
  name: 'Alt',
  category: 'company',
})
@Injectable()
export class AltService implements IScraper {
  private readonly logger = new Logger(AltService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Alt: fetching ${url}`);

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
        const id = `alt-${jobId}`;

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
            site: Site.ALT,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'Alt',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/alt/jobs/${listing.id}`,
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

      this.logger.log(`Alt: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Alt scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
