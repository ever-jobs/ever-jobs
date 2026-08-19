import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Helsing — European defense-tech company building AI software and autonomous systems for military and national-security applications..
 *
 * Helsing is a European defense technology company that develops
 * artificial intelligence software to process sensor and weapon-system
 * data for military and national-security use. Its products span AI
 * for intelligence, surveillance, and reconnaissance, electronic
 * warfare, and autonomous systems including strike drones and
 * aircraft. Founded in 2021, the company operates across Germany, the
 * UK, and France, serving European defense ministries and armed
 * forces. It is among Europe's most highly valued defense-tech
 * startups.
 *
 * Sector: Defense Tech / AI. HQ: Munich, Bavaria, Germany.
 *
 * Highlights:
 *   - Founded in 2021; headquartered in Munich, Germany
 *   - Builds AI software for defense, including ISR, electronic
 *     warfare, and autonomous systems
 *   - Operates major hubs across Germany, the United Kingdom, and
 *     France
 *   - Hires AI research and engineering roles in areas such as AI
 *     safety and computer vision
 *   - One of Europe's highest-valued defense-technology companies
 *
 * Source profile (Spec 781):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/helsing/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'Helsing'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 134 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/helsing/jobs';

@SourcePlugin({
  site: Site.HELSING,
  name: 'Helsing',
  category: 'company',
})
@Injectable()
export class HelsingService implements IScraper {
  private readonly logger = new Logger(HelsingService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Helsing: fetching ${url}`);

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
        const id = `helsing-${jobId}`;

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
            site: Site.HELSING,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'Helsing',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/helsing/jobs/${listing.id}`,
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

      this.logger.log(`Helsing: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Helsing scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
