import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Loop — AI data platform for global supply chain and freight.
 *
 * Loop is an AI-native data platform for the global supply chain,
 * using custom logistics-trained models to extract, normalize, and
 * link messy transportation data from PDFs, emails, EDI feeds, and
 * legacy systems into a single source of truth. The platform automates
 * freight audits, payments, and exception handling for shippers and
 * enterprise customers. Founded by former Uber Freight team members,
 * Loop is headquartered in San Francisco.
 *
 * Sector: Logistics AI / Freight audit & payment. HQ: San Francisco, CA.
 *
 * Highlights:
 *   - Built DUX, a proprietary logistics foundation model trained on
 *     millions of documents to power document extraction and over 99%
 *     touchless automation
 *   - Offers freight audit and payment, exception management agents,
 *     and an analytics layer (Loop Intelligence) for transportation
 *     spend visibility
 *   - Raised a $95M Series C led by Valor Equity Partners, with
 *     backing from 8VC, Founders Fund, Index Ventures, and J.P. Morgan
 *     Growth Equity Partners
 *
 * Source profile (Spec 628):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/loop/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'Loop'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 10 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/loop/jobs';

@SourcePlugin({
  site: Site.LOOP,
  name: 'Loop',
  category: 'company',
})
@Injectable()
export class LoopService implements IScraper {
  private readonly logger = new Logger(LoopService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Loop: fetching ${url}`);

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
        const id = `loop-${jobId}`;

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
            site: Site.LOOP,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'Loop',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/loop/jobs/${listing.id}`,
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

      this.logger.log(`Loop: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Loop scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
