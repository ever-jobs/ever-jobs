import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Keeper Security — Cybersecurity company offering zero-knowledge password, secrets, and privileged access management..
 *
 * Keeper Security, Inc. is a cybersecurity company founded in 2011 by
 * Darren Guccione and Craig Lurey, headquartered in Chicago, Illinois.
 * It develops zero-knowledge, encryption-based software for password
 * management, secrets management, and privileged access management
 * (PAM) used by individuals, families, and enterprises. The company
 * maintains additional offices including product development in El
 * Dorado Hills, California and EMEA business operations in Cork,
 * Ireland.
 *
 * Sector: Cybersecurity. HQ: Chicago, United States.
 *
 * Highlights:
 *   - Provides a zero-knowledge encrypted password manager and digital
 *     vault for consumers and businesses
 *   - Offers enterprise products spanning secrets management and
 *     privileged access management (PAM), including sales to SLED
 *     (state, local, and education) public-sector customers
 *   - Operates globally with its Chicago headquarters and an EMEA hub
 *     in Cork, Ireland
 *
 * Source profile (Spec 697):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/keepersecurity/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'Keeper Security'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 92 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/keepersecurity/jobs';

@SourcePlugin({
  site: Site.KEEPER_SECURITY,
  name: 'Keeper Security',
  category: 'company',
})
@Injectable()
export class KeeperSecurityService implements IScraper {
  private readonly logger = new Logger(KeeperSecurityService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Keeper Security: fetching ${url}`);

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
        const id = `keepersecurity-${jobId}`;

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
            site: Site.KEEPER_SECURITY,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'Keeper Security',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/keepersecurity/jobs/${listing.id}`,
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

      this.logger.log(`Keeper Security: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Keeper Security scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
