import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Carrot Fertility — Carrot Fertility provides employer-sponsored fertility and family-building benefits delivered as a managed health platform..
 *
 * Carrot Fertility is a benefits company that offers fertility care
 * and family-building support, including fertility preservation, IVF,
 * adoption, surrogacy, menopause, and related services, made available
 * to members through their employers and health plans. The company
 * combines financial benefit administration with clinical guidance and
 * a care navigation team. It serves employers and health plans across
 * multiple countries.
 *
 * Sector: Fertility & family-building benefits. HQ: Menlo Park, United States.
 *
 * Highlights:
 *   - Offers fertility and family-building benefits including IVF,
 *     fertility preservation, adoption, and surrogacy support
 *   - Sold primarily to employers and health plans that provide the
 *     benefit to their members
 *   - Sample roles span sales, applied AI engineering, and regulatory
 *     legal, all listed as Remote
 *
 * Source profile (Spec 648):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/carrotfertility/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'Carrot Fertility'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 12 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/carrotfertility/jobs';

@SourcePlugin({
  site: Site.CARROT_FERTILITY,
  name: 'Carrot Fertility',
  category: 'company',
})
@Injectable()
export class CarrotFertilityService implements IScraper {
  private readonly logger = new Logger(CarrotFertilityService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Carrot Fertility: fetching ${url}`);

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
        const id = `carrotfertility-${jobId}`;

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
            site: Site.CARROT_FERTILITY,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'Carrot Fertility',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/carrotfertility/jobs/${listing.id}`,
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

      this.logger.log(`Carrot Fertility: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Carrot Fertility scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
