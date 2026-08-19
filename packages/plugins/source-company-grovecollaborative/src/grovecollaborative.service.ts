import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Grove Collaborative — Grove Collaborative is a digital-first consumer products retailer selling sustainable, eco-friendly household, personal care, and wellness goods..
 *
 * Grove Collaborative is a public-benefit consumer products company
 * (NYSE: GROV) offering a curated marketplace of sustainable
 * household, personal care, and wellness products, including its own
 * private brands. It operates a direct-to-consumer e-commerce platform
 * and retail distribution, with a focus on plastic-free and
 * environmentally responsible goods. The company hires remote
 * engineering and operations talent, including AI-first mobile and
 * marketplace roles.
 *
 * Sector: Sustainable consumer goods / E-commerce. HQ: San Francisco, USA.
 *
 * Highlights:
 *   - Digital-first marketplace for sustainable, eco-friendly
 *     household and personal care products
 *   - Publicly traded certified B Corp and public-benefit corporation
 *     (NYSE: GROV)
 *   - Hiring remote roles spanning AI-first mobile engineering and
 *     marketplace operations
 *
 * Source profile (Spec 674):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/grovecollaborative/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'Grove Collaborative'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 12 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/grovecollaborative/jobs';

@SourcePlugin({
  site: Site.GROVE_COLLABORATIVE,
  name: 'Grove Collaborative',
  category: 'company',
})
@Injectable()
export class GroveCollaborativeService implements IScraper {
  private readonly logger = new Logger(GroveCollaborativeService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Grove Collaborative: fetching ${url}`);

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
        const id = `grovecollaborative-${jobId}`;

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
            site: Site.GROVE_COLLABORATIVE,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'Grove Collaborative',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/grovecollaborative/jobs/${listing.id}`,
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

      this.logger.log(`Grove Collaborative: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Grove Collaborative scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
