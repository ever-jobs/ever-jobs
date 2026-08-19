import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Altana  — AI-powered platform for global trade and supply chain intelligence..
 *
 * Altana is a supply chain and global trade intelligence company
 * headquartered in Brooklyn, NY, and founded in 2018. Its platform,
 * the Altana Atlas, applies AI to model networks of buyer-supplier
 * relationships across global value chains, supporting use cases such
 * as supply chain visibility, trade compliance, procurement, and risk
 * management. The company serves both commercial enterprises
 * (including large logistics providers) and government and public
 * sector customers. Hiring across Government Affairs, Product
 * Management, Engineering, Design, and Finance spans U.S. offices and
 * a Brussels, Belgium presence.
 *
 * Sector: Supply Chain & Trade Intelligence (AI / SaaS). HQ: Brooklyn, NY, USA.
 *
 * Highlights:
 *   - Builds the Altana Atlas, an AI platform mapping global value
 *     chains and buyer-supplier networks
 *   - Serves commercial and public sector customers across trade
 *     compliance, visibility, and procurement
 *   - Headquartered in Brooklyn, NY (Williamsburg), founded in 2018
 *   - U.S. footprint across NY, San Francisco, Washington DC, and
 *     Boston, plus a Brussels, Belgium office
 *   - Hiring spans Engineering, Product Management, Design, Government
 *     Affairs, Operations, and Finance
 *
 * Source profile (Spec 246):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/altanaai/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'Altana '`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 22 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/altanaai/jobs';

@SourcePlugin({
  site: Site.ALTANAAI,
  name: 'Altana ',
  category: 'company',
})
@Injectable()
export class AltanaaiService implements IScraper {
  private readonly logger = new Logger(AltanaaiService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Altana : fetching ${url}`);

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
        const id = `altanaai-${jobId}`;

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
            site: Site.ALTANAAI,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'Altana ',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/altanaai/jobs/${listing.id}`,
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

      this.logger.log(`Altana : scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Altana  scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
