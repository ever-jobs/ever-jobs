import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * ANINE BING — Los Angeles-based women's fashion brand selling apparel and accessories via DTC, retail stores, and wholesale..
 *
 * ANINE BING is an American women's fashion brand founded in 2012 in
 * Los Angeles by Danish-born designer Anine Bing and Nicolai Bing. It
 * designs apparel, footwear, accessories, and fragrance, blending
 * Scandinavian minimalism with a Los Angeles aesthetic. The company
 * sells through its own ecommerce site, a global network of retail
 * stores, and wholesale partners, with operations across the US and
 * Europe.
 *
 * Sector: Apparel & Fashion Retail. HQ: Los Angeles, USA.
 *
 * Highlights:
 *   - Women's apparel, footwear, accessories, and fragrance brand
 *   - Founded in 2012 in Los Angeles by Anine Bing and Nicolai Bing
 *   - Omnichannel: direct ecommerce, owned retail stores, and
 *     wholesale
 *   - Operations span the US and Europe, with stores in New York, Los
 *     Angeles, and Paris
 *   - Hiring across Finance, Wholesale, Retail (US/EU), Ecommerce &
 *     Digital Marketing, and People/HR
 *
 * Source profile (Spec 270):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/aninebing/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'ANINE BING'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 20 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/aninebing/jobs';

@SourcePlugin({
  site: Site.ANINEBING,
  name: 'ANINE BING',
  category: 'company',
})
@Injectable()
export class AninebingService implements IScraper {
  private readonly logger = new Logger(AninebingService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`ANINE BING: fetching ${url}`);

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
        const id = `aninebing-${jobId}`;

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
            site: Site.ANINEBING,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'ANINE BING',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/aninebing/jobs/${listing.id}`,
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

      this.logger.log(`ANINE BING: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`ANINE BING scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
