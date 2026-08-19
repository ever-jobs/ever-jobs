import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Pivot Bio — Agricultural biotech company developing nitrogen-producing microbial products that replace synthetic fertilizer for row crops..
 *
 * Pivot Bio is an agricultural biotechnology company that develops
 * microbial nitrogen products for farmers, using engineered soil
 * microbes that colonize crop roots and produce nitrogen throughout
 * the growing season. Its products are designed to supplement or
 * reduce reliance on synthetic nitrogen fertilizer for crops such as
 * corn, wheat, and sorghum. The company sells directly to farmers and
 * supports them through field agronomists and commercial teams across
 * U.S. agricultural regions. It also participates in carbon and
 * sustainability programs tied to reduced fertilizer use.
 *
 * Sector: AgTech / Agricultural Biotechnology. HQ: Berkeley, California, USA.
 *
 * Highlights:
 *   - Develops microbial nitrogen-fixing products as an alternative to
 *     synthetic fertilizer
 *   - Serves row-crop farmers (corn, wheat, sorghum) across U.S.
 *     agricultural regions
 *   - Field-based commercial and agronomy teams support growers
 *     directly
 *   - Headquartered in Berkeley, California
 *   - Operates in the AgTech and agricultural biotechnology sector
 *
 * Source profile (Spec 783):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/pivotbio/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'Pivot Bio'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 18 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/pivotbio/jobs';

@SourcePlugin({
  site: Site.PIVOT_BIO,
  name: 'Pivot Bio',
  category: 'company',
})
@Injectable()
export class PivotBioService implements IScraper {
  private readonly logger = new Logger(PivotBioService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Pivot Bio: fetching ${url}`);

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
        const id = `pivotbio-${jobId}`;

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
            site: Site.PIVOT_BIO,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'Pivot Bio',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/pivotbio/jobs/${listing.id}`,
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

      this.logger.log(`Pivot Bio: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Pivot Bio scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
