import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * EarnIn — EarnIn is a fintech app that lets workers access wages they have already earned before their scheduled payday..
 *
 * EarnIn is a financial technology company (not a bank) offering
 * earned-wage access and financial-wellness tools that let users get
 * paid for hours they have already worked, ahead of their normal
 * payday. Founded in 2012 and originally named Activehours, it is
 * headquartered in Mountain View, California. Its product suite
 * includes early wage access (Cash Out), Balance Shield, credit
 * monitoring, automated savings, and an EarnIn Payroll offering. The
 * Greenhouse board slug "earnin" and Mountain View / Remote US roles
 * are consistent with this company.
 *
 * Sector: Fintech / Earned-Wage Access. HQ: Mountain View, California, United States.
 *
 * Highlights:
 *   - Founded in 2012, formerly known as Activehours
 *   - Headquartered in Mountain View, California, with a
 *     remote-friendly US workforce
 *   - Provides earned-wage access ("Cash Out") plus Balance Shield,
 *     credit monitoring, and automated savings
 *   - Launched EarnIn Payroll in October 2025
 *   - Roughly 580+ employees as of 2026
 *
 * Source profile (Spec 791):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/earnin/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'EarnIn'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 44 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/earnin/jobs';

@SourcePlugin({
  site: Site.EARNIN,
  name: 'EarnIn',
  category: 'company',
})
@Injectable()
export class EarnInService implements IScraper {
  private readonly logger = new Logger(EarnInService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`EarnIn: fetching ${url}`);

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
        const id = `earnin-${jobId}`;

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
            site: Site.EARNIN,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'EarnIn',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/earnin/jobs/${listing.id}`,
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

      this.logger.log(`EarnIn: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`EarnIn scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
