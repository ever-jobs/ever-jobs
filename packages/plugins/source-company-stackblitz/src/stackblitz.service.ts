import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * StackBlitz — StackBlitz makes bolt.new, an AI app builder, and WebContainers, browser-based Node.js runtime tech..
 *
 * StackBlitz Inc. is a developer-tools company best known for
 * bolt.new, an AI-powered web app builder that lets users generate,
 * run, and deploy full-stack applications from natural-language
 * prompts directly in the browser. It is also the maker of
 * WebContainers, a technology that runs Node.js entirely in the
 * browser, which powers its in-browser development environments. The
 * company hires across community, customer experience, and engineering
 * roles, largely on a remote basis.
 *
 * Sector: AI Developer Tools / App Builder. HQ: San Francisco, USA.
 *
 * Highlights:
 *   - Creator of bolt.new, an AI app builder that generates and
 *     deploys full-stack web apps from prompts
 *   - Developed WebContainers, a browser-based runtime that executes
 *     Node.js without a server
 *   - Hiring remote roles spanning community, customer experience, and
 *     engineering
 *
 * Source profile (Spec 700):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/stackblitz/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'StackBlitz'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 13 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/stackblitz/jobs';

@SourcePlugin({
  site: Site.STACKBLITZ,
  name: 'StackBlitz',
  category: 'company',
})
@Injectable()
export class StackBlitzService implements IScraper {
  private readonly logger = new Logger(StackBlitzService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`StackBlitz: fetching ${url}`);

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
        const id = `stackblitz-${jobId}`;

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
            site: Site.STACKBLITZ,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'StackBlitz',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/stackblitz/jobs/${listing.id}`,
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

      this.logger.log(`StackBlitz: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`StackBlitz scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
