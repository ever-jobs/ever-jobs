import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Addepar — Cloud-based wealth management platform for portfolio data aggregation, analytics, and reporting.
 *
 * Addepar is a financial technology company that provides a
 * cloud-based wealth management software platform focused on portfolio
 * data aggregation, analytics, and reporting for registered investment
 * advisors, family offices, banks, and other institutions. Founded in
 * 2009, the company is used by firms across many countries to
 * consolidate and analyze client investment data, including
 * alternative assets. The hiring signals span client-facing support
 * and data operations functions, with the listed roles reflecting work
 * in onboarding/servicing clients and processing investment data
 * (including alternatives).
 *
 * Sector: Fintech (Wealth Management Software). HQ: Mountain View, California, USA.
 *
 * Highlights:
 *   - Founded in 2009; provides portfolio reporting and analytics
 *     software for the wealth management industry
 *   - Serves registered investment advisors, family offices, and
 *     financial institutions
 *   - Platform emphasizes aggregating and analyzing investment data,
 *     including alternative assets ('Alts')
 *   - Operates internationally with offices including Edinburgh, UK
 *     and Pune, India
 *   - Hiring spans Client Support and Data Operations functions
 *
 * Source profile (Spec 190):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/addepar1/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'Addepar'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 119 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/addepar1/jobs';

@SourcePlugin({
  site: Site.ADDEPAR1,
  name: 'Addepar',
  category: 'company',
})
@Injectable()
export class Addepar1Service implements IScraper {
  private readonly logger = new Logger(Addepar1Service.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Addepar: fetching ${url}`);

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
        const id = `addepar1-${jobId}`;

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
            site: Site.ADDEPAR1,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'Addepar',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/addepar1/jobs/${listing.id}`,
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

      this.logger.log(`Addepar: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Addepar scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
