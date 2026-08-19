import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * apiphani — Technology-enabled managed services for mission-critical SAP and tier-1 enterprise applications..
 *
 * apiphani is a technology-enabled IT managed services company focused
 * on running and supporting mission-critical, tier-1 enterprise
 * applications, with a particular specialization in SAP environments
 * (including SAP Basis, S/4HANA, BTP, and RISE with SAP). It combines
 * senior engineering teams with proprietary automation and
 * observability tooling (marketed as Deep Automation and the
 * Luumen/Aegis offerings) to provide monitoring, cloud migration,
 * security, and compliance support, frequently running SAP workloads
 * on AWS. The company serves regulated and enterprise clients and
 * operates internationally, with offices in Boston and Lisbon and
 * staff across multiple countries. Founded in 2018, it is privately
 * held.
 *
 * Sector: IT Services & Consulting (SAP Managed Services). HQ: Boston, MA, United States.
 *
 * Highlights:
 *   - Specializes in managed services for SAP environments (SAP Basis,
 *     S/4HANA, BTP, RISE with SAP) and other mission-critical
 *     applications
 *   - Uses proprietary automation and observability tooling (Deep
 *     Automation, Luumen, Aegis) alongside senior engineers
 *   - AWS and SAP certified partner; commonly runs and migrates SAP
 *     workloads to the cloud
 *   - Serves regulated-industry and enterprise clients, with dedicated
 *     regulated SAP application support
 *   - Internationally distributed with offices in Boston and Lisbon
 *     and remote staff across multiple countries
 *
 * Source profile (Spec 284):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/apiphani/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'apiphani'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 9 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/apiphani/jobs';

@SourcePlugin({
  site: Site.APIPHANI,
  name: 'apiphani',
  category: 'company',
})
@Injectable()
export class ApiphaniService implements IScraper {
  private readonly logger = new Logger(ApiphaniService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`apiphani: fetching ${url}`);

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
        const id = `apiphani-${jobId}`;

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
            site: Site.APIPHANI,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'apiphani',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/apiphani/jobs/${listing.id}`,
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

      this.logger.log(`apiphani: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`apiphani scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
