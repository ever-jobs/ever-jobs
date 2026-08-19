import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Aperia — Dallas-based fintech building payments software, data systems, and PCI compliance tooling..
 *
 * Aperia (Aperia Solutions) is a Dallas, Texas-based fintech and
 * software services firm founded in 2001 that builds custom SaaS
 * applications, data and reconciliation systems, and analytics for the
 * payments, banking, and processing industry. Its offerings include
 * solution development, hosted/private cloud services, risk
 * management, and PCI compliance tooling (Aperia Compliance) for ISOs,
 * processors, and merchants. The company also serves government and
 * regulatory use cases, with operations across U.S. sites and an
 * offshore engineering presence in Vietnam.
 *
 * Sector: Fintech / Payments software and compliance. HQ: Dallas, Texas, United States.
 *
 * Highlights:
 *   - Founded in 2001, focused on payments and processing software
 *   - Builds custom SaaS, data/reconciliation, and analytics platforms
 *   - Operates a PCI and risk-management compliance unit (Aperia
 *     Compliance)
 *   - Multi-site U.S. operations with offshore engineering in Ho Chi
 *     Minh City, Vietnam
 *   - Hiring signals include DevOps and Project Management across
 *     Systems and MR teams
 *
 * Source profile (Spec 280):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/aperiasolutions/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'Aperia'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 7 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/aperiasolutions/jobs';

@SourcePlugin({
  site: Site.APERIASOLUTIONS,
  name: 'Aperia',
  category: 'company',
})
@Injectable()
export class AperiasolutionsService implements IScraper {
  private readonly logger = new Logger(AperiasolutionsService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Aperia: fetching ${url}`);

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
        const id = `aperiasolutions-${jobId}`;

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
            site: Site.APERIASOLUTIONS,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'Aperia',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/aperiasolutions/jobs/${listing.id}`,
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

      this.logger.log(`Aperia: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Aperia scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
