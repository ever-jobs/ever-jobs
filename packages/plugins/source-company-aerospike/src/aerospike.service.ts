import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Aerospike — Real-time NoSQL distributed database for high-throughput, low-latency data workloads.
 *
 * Aerospike, Inc. develops a real-time, high-performance NoSQL
 * distributed database used for applications requiring low-latency
 * access to large data sets, such as fraud detection, recommendation
 * engines, and adtech. Founded in 2009 (originally as Citrusleaf,
 * rebranded to Aerospike in 2012), the company offers its database as
 * both self-managed software and a managed cloud service. It operates
 * internationally, with the sampled sales roles in Tel Aviv and London
 * pointing to a commercial presence across the EMEA region.
 *
 * Sector: Enterprise Software (Database / Data Infrastructure). HQ: Mountain View, California, USA.
 *
 * Highlights:
 *   - Builds a distributed real-time NoSQL database designed for
 *     low-latency access at large scale
 *   - Founded in 2009; originally named Citrusleaf, rebranded to
 *     Aerospike in 2012
 *   - Co-founded by Brian Bulkowski and Srini Srinivasan
 *   - Maintains international offices including Tel Aviv and London
 *     (per sampled sales roles)
 *   - Sampled open roles are in the Sales function (Account Executive
 *     and Account Manager)
 *
 * Source profile (Spec 198):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/aerospike/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'Aerospike'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 12 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/aerospike/jobs';

@SourcePlugin({
  site: Site.AEROSPIKE,
  name: 'Aerospike',
  category: 'company',
})
@Injectable()
export class AerospikeService implements IScraper {
  private readonly logger = new Logger(AerospikeService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Aerospike: fetching ${url}`);

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
        const id = `aerospike-${jobId}`;

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
            site: Site.AEROSPIKE,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'Aerospike',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/aerospike/jobs/${listing.id}`,
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

      this.logger.log(`Aerospike: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Aerospike scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
