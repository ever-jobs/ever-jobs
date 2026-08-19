import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Appian Corporation  — Enterprise low-code platform for building applications and automating business processes..
 *
 * Appian Corporation is a publicly traded enterprise software company
 * that provides a low-code platform for building applications and
 * automating business processes, including workflow, case management,
 * and process automation capabilities. Its hiring spans engineering,
 * sales, finance, customer success, and business technology, with
 * roles concentrated in regulated sectors such as banking, financial
 * services, and the U.S. federal government. The company maintains a
 * presence across the United States and Europe, reflected in postings
 * in Virginia, North Carolina, Georgia, Germany, and Spain.
 *
 * Sector: Enterprise software (low-code / process automation). HQ: McLean, Virginia, United States.
 *
 * Highlights:
 *   - Low-code application development and process automation platform
 *   - Strong focus on regulated verticals: banking, financial
 *     services, and federal/public sector
 *   - International footprint across the US and Europe (Germany,
 *     Spain)
 *   - Hiring across engineering, sales, finance, customer success, and
 *     business technology
 *
 * Source profile (Spec 292):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/appian/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'Appian Corporation '`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 192 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/appian/jobs';

@SourcePlugin({
  site: Site.APPIAN,
  name: 'Appian Corporation ',
  category: 'company',
})
@Injectable()
export class AppianService implements IScraper {
  private readonly logger = new Logger(AppianService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Appian Corporation : fetching ${url}`);

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
        const id = `appian-${jobId}`;

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
            site: Site.APPIAN,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'Appian Corporation ',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/appian/jobs/${listing.id}`,
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

      this.logger.log(`Appian Corporation : scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Appian Corporation  scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
