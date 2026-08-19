import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Sila Nanotechnologies — Sila Nanotechnologies is a battery materials company that develops silicon-based anode materials to increase the energy density of lithium-ion batteries..
 *
 * Sila Nanotechnologies develops next-generation battery materials,
 * with a flagship silicon anode material (Titan Silicon) designed to
 * replace graphite and boost the energy density of lithium-ion
 * batteries. Its materials target applications across consumer
 * electronics and electric vehicles. The company operates a
 * manufacturing facility in Moses Lake, Washington, to scale
 * production of its anode material.
 *
 * Sector: Battery Materials / CleanTech. HQ: Alameda, California, USA.
 *
 * Highlights:
 *   - Silicon anode materials for lithium-ion batteries
 *   - Flagship product: Titan Silicon anode
 *   - Headquartered in Alameda, California
 *   - Manufacturing facility in Moses Lake, Washington
 *   - Serves EV and consumer electronics battery markets
 *
 * Source profile (Spec 769):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/silananotechnologies/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'Sila Nanotechnologies'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 27 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/silananotechnologies/jobs';

@SourcePlugin({
  site: Site.SILA_NANOTECHNOLOGIES,
  name: 'Sila Nanotechnologies',
  category: 'company',
})
@Injectable()
export class SilaNanotechnologiesService implements IScraper {
  private readonly logger = new Logger(SilaNanotechnologiesService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Sila Nanotechnologies: fetching ${url}`);

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
        const id = `silananotechnologies-${jobId}`;

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
            site: Site.SILA_NANOTECHNOLOGIES,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'Sila Nanotechnologies',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/silananotechnologies/jobs/${listing.id}`,
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

      this.logger.log(`Sila Nanotechnologies: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Sila Nanotechnologies scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
