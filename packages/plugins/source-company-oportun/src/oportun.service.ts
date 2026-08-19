import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Oportun — Mission-driven financial services company providing affordable, inclusive credit and savings tools to underserved consumers.
 *
 * Oportun is a mission-driven financial services company that aims to
 * make financial health attainable for low-to-moderate income
 * consumers, including those with limited or no credit history. It
 * offers personal loans, credit cards, and savings and budgeting
 * tools, delivered online, by phone, and through retail and
 * lending-as-a-service partner locations. The company uses data-driven
 * underwriting to extend responsible, affordable credit to people
 * often overlooked by traditional providers. Oportun is publicly
 * traded on Nasdaq under the ticker OPRT.
 *
 * Sector: Fintech / Consumer Lending. HQ: San Carlos, California, USA.
 *
 * Highlights:
 *   - Headquartered in San Carlos, California
 *   - Publicly traded on Nasdaq (ticker: OPRT)
 *   - Offers personal loans, credit cards, and savings/budgeting tools
 *   - Has extended more than $22 billion in credit since inception
 *   - Serves low-to-moderate income and credit-underserved consumers
 *
 * Source profile (Spec 754):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/oportun/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'Oportun'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 32 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/oportun/jobs';

@SourcePlugin({
  site: Site.OPORTUN,
  name: 'Oportun',
  category: 'company',
})
@Injectable()
export class OportunService implements IScraper {
  private readonly logger = new Logger(OportunService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Oportun: fetching ${url}`);

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
        const id = `oportun-${jobId}`;

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
            site: Site.OPORTUN,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'Oportun',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/oportun/jobs/${listing.id}`,
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

      this.logger.log(`Oportun: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Oportun scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
