import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * AppDirect — Commerce platform for selling and managing subscription products through digital marketplaces..
 *
 * AppDirect is a commerce platform company that enables businesses to
 * sell, distribute, and manage subscription-based products and
 * services through digital marketplaces. Headquartered in San
 * Francisco, it operates across multiple regions including North
 * America, South America, and Europe, with offices and teams in cities
 * such as Toronto, Buenos Aires, and the United Kingdom. The company
 * supports software vendors, advisors, and channel partners with tools
 * for billing, provisioning, and partner/reseller management.
 *
 * Sector: B2B SaaS / Subscription Commerce. HQ: San Francisco, CA, US.
 *
 * Highlights:
 *   - Operates a subscription-commerce and digital marketplace
 *     platform for software and services
 *   - Distributed workforce across San Francisco, Toronto, Buenos
 *     Aires, the UK, and El Salvador
 *   - Hiring spans sales, finance/controllership, and revenue
 *     functions
 *   - Departments referencing PartnerStack and Firstbase indicate a
 *     partner-ecosystem and brand portfolio
 *
 * Source profile (Spec 290):
 *   - D-04 — Greenhouse canonical hosted-board host (variant 2):
 *     `https://job-boards.greenhouse.io/appdirect/jobs/<id>`.
 *   - D-08 — entity-decode-then-tag-strip description pipeline.
 *   - D-09 — wire `company_name` pass-through (`'AppDirect'`).
 *   - D-10 — defensive `.trim()` on wire titles (padding observed
 *     on the run-398 batch probe).
 *   - D-11 — defensive `.trim()` on wire department names.
 *
 * Probed 76 live role(s) on the run-398 batch sweep.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/appdirect/jobs';

@SourcePlugin({
  site: Site.APPDIRECT,
  name: 'AppDirect',
  category: 'company',
})
@Injectable()
export class AppdirectService implements IScraper {
  private readonly logger = new Logger(AppdirectService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`AppDirect: fetching ${url}`);

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
        const id = `appdirect-${jobId}`;

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
            site: Site.APPDIRECT,
            title,
            // D-09 pass-through: wire `company_name`.
            companyName: listing.company_name ?? 'AppDirect',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/appdirect/jobs/${listing.id}`,
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

      this.logger.log(`AppDirect: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`AppDirect scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
