import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Clutch — Canadian online platform for buying and selling used cars.
 *
 * Clutch (Clutch Technologies Inc.) is a Canadian online used-car
 * retailer that lets customers buy, sell, and trade vehicles entirely
 * online, with home delivery and pickup. The company inspects and
 * reconditions cars it acquires from individuals, auctions, and
 * trade-ins, selling them at non-negotiable prices with a money-back
 * guarantee and CARFAX history reports. Founded in 2016, it operates
 * retail hubs and pickup locations across Ontario, the Atlantic
 * provinces, and British Columbia.
 *
 * Sector: Online automotive retail (used-car e-commerce). HQ: Toronto, Canada.
 *
 * Highlights:
 *   - Operates a 100% online used-car marketplace with inspection,
 *     reconditioning, financing, and at-home delivery across multiple
 *     Canadian provinces
 *   - Booked roughly C$320 million in revenue in 2024 and grew to over
 *     500 employees, with retail hubs in Mississauga, Etobicoke,
 *     Halifax, and Richmond
 *   - Every vehicle includes a multi-point inspection and CARFAX
 *     report, sold with upfront pricing and a 10-day money-back
 *     guarantee
 *
 * Source profile (Spec 620):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/clutch/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'Clutch'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 70 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/clutch/jobs';

@SourcePlugin({
  site: Site.CLUTCH,
  name: 'Clutch',
  category: 'company',
})
@Injectable()
export class ClutchService implements IScraper {
  private readonly logger = new Logger(ClutchService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Clutch: fetching ${url}`);

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
        const id = `clutch-${jobId}`;

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
            site: Site.CLUTCH,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'Clutch',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/clutch/jobs/${listing.id}`,
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

      this.logger.log(`Clutch: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Clutch scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
