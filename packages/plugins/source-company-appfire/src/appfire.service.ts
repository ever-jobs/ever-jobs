import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Appfire — Software company building productivity and workflow apps for Atlassian, Microsoft, and other platforms..
 *
 * Appfire is a software company that builds productivity, project
 * management, and workflow apps that extend platforms such as
 * Atlassian (Jira and Confluence), Microsoft, and monday.com. The
 * company has grown substantially through acquisitions, consolidating
 * numerous marketplace app vendors under a single portfolio. Its
 * hiring spans Engineering, Information Security, Customer Success,
 * Data Insights, and Finance functions across teams in Europe and
 * India.
 *
 * Sector: Enterprise Software / SaaS. HQ: Burlington, Massachusetts, USA.
 *
 * Highlights:
 *   - Develops apps that extend Atlassian (Jira, Confluence),
 *     Microsoft, and monday.com platforms
 *   - Grew its product portfolio through a series of marketplace app
 *     acquisitions
 *   - Distributed engineering and operations presence across Bulgaria,
 *     Spain, Poland, and India
 *   - Active hiring in Information Security and GRC, including a
 *     dedicated security analyst function
 *
 * Source profile (Spec 291):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/appfire/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'Appfire'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 20 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/appfire/jobs';

@SourcePlugin({
  site: Site.APPFIRE,
  name: 'Appfire',
  category: 'company',
})
@Injectable()
export class AppfireService implements IScraper {
  private readonly logger = new Logger(AppfireService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Appfire: fetching ${url}`);

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
        const id = `appfire-${jobId}`;

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
            site: Site.APPFIRE,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'Appfire',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/appfire/jobs/${listing.id}`,
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

      this.logger.log(`Appfire: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Appfire scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
