import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * ALX Africa — Pan-African technology and leadership training provider building digital skills across the continent..
 *
 * ALX Africa is a pan-African technology and leadership training
 * provider that equips young people across the continent with
 * in-demand digital and professional skills through programs in areas
 * such as software engineering, data, cloud, and AI. Part of the
 * broader African Leadership Group ecosystem, it operates learning
 * hubs and community programs in multiple African cities. The roles
 * and departments observed reflect this footprint, spanning alumni and
 * community functions, business automation, and city-based teams in
 * Casablanca, Cairo, Accra, and Kigali.
 *
 * Sector: Education / Workforce Training. HQ: Unknown.
 *
 * Highlights:
 *   - Trains learners across multiple African cities including
 *     Casablanca, Cairo, Accra, and Kigali
 *   - Programs span technology skills such as software engineering,
 *     data, cloud, and AI
 *   - Part of the African Leadership Group ecosystem
 *   - Maintains alumni relations and community-focused teams
 *   - Operates with both remote and in-person, city-based hiring
 *
 * Source profile (Spec 254):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/alxafrica/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'ALX Africa'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 19 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/alxafrica/jobs';

@SourcePlugin({
  site: Site.ALXAFRICA,
  name: 'ALX Africa',
  category: 'company',
})
@Injectable()
export class AlxafricaService implements IScraper {
  private readonly logger = new Logger(AlxafricaService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`ALX Africa: fetching ${url}`);

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
        const id = `alxafrica-${jobId}`;

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
            site: Site.ALXAFRICA,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'ALX Africa',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/alxafrica/jobs/${listing.id}`,
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

      this.logger.log(`ALX Africa: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`ALX Africa scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
