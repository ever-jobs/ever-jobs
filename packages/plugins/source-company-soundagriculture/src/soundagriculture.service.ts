import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Sound Agriculture — Agriculture biotech company developing nutrient-efficiency and on-demand crop trait products to improve farm yields and sustainability..
 *
 * Sound Agriculture is an agricultural biotechnology company that
 * develops products to make crops more productive and
 * nutrient-efficient. Its flagship offering helps plants better access
 * existing soil nutrients, reducing reliance on synthetic fertilizer
 * inputs. The company also pursues on-demand breeding technology to
 * accelerate the development of new crop varieties. It sells primarily
 * to row-crop growers and agricultural retail channels across the
 * United States.
 *
 * Sector: AgTech / Agricultural Biotechnology. HQ: Emeryville, California, USA.
 *
 * Highlights:
 *   - Agricultural biotechnology focused on crop nutrient efficiency
 *     and yield
 *   - Flagship product improves plant access to soil nutrients,
 *     reducing fertilizer needs
 *   - On-demand breeding platform to speed development of new crop
 *     traits
 *   - Serves U.S. row-crop growers via agronomy and agricultural sales
 *     teams
 *   - Headquartered in Emeryville, California, with remote and
 *     field-based roles
 *
 * Source profile (Spec 786):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/soundagriculture/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'Sound Agriculture'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 4 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/soundagriculture/jobs';

@SourcePlugin({
  site: Site.SOUND_AGRICULTURE,
  name: 'Sound Agriculture',
  category: 'company',
})
@Injectable()
export class SoundAgricultureService implements IScraper {
  private readonly logger = new Logger(SoundAgricultureService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Sound Agriculture: fetching ${url}`);

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
        const id = `soundagriculture-${jobId}`;

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
            site: Site.SOUND_AGRICULTURE,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'Sound Agriculture',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/soundagriculture/jobs/${listing.id}`,
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

      this.logger.log(`Sound Agriculture: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Sound Agriculture scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
