import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Affinidi — Decentralized digital identity and verifiable-credentials infrastructure for consent-based data sharing.
 *
 * Affinidi is a digital identity and personal-data technology company
 * that builds infrastructure for decentralized identity and
 * consent-based data sharing. Its platform issues, verifies, and
 * manages W3C Verifiable Credentials and provides a holder wallet that
 * lets individuals store and selectively share credentials, alongside
 * developer tools for businesses to issue and verify them. The company
 * was founded with backing from Temasek and is headquartered in
 * Singapore, with additional engineering presence in Europe and India.
 * Its hiring here centers on backend engineering (including Rust)
 * staffed out of European locations.
 *
 * Sector: Digital Identity / Privacy Technology. HQ: Singapore.
 *
 * Highlights:
 *   - Builds infrastructure for decentralized identity using W3C
 *     Verifiable Credentials and DID standards
 *   - Offers a personal-data wallet plus developer tooling to issue
 *     and verify credentials (OID4VCI / OID4VP)
 *   - Founded with backing from Singapore's Temasek
 *   - Engineering roles in this listing are based in Dublin, London,
 *     and Berlin
 *   - Sample role indicates use of Rust on backend systems
 *
 * Source profile (Spec 200):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/affinidi/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'Affinidi'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 22 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/affinidi/jobs';

@SourcePlugin({
  site: Site.AFFINIDI,
  name: 'Affinidi',
  category: 'company',
})
@Injectable()
export class AffinidiService implements IScraper {
  private readonly logger = new Logger(AffinidiService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Affinidi: fetching ${url}`);

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
        const id = `affinidi-${jobId}`;

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
            site: Site.AFFINIDI,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'Affinidi',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/affinidi/jobs/${listing.id}`,
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

      this.logger.log(`Affinidi: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Affinidi scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
