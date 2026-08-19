import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Klaviyo, Inc. — email / SMS / customer-data marketing-automation
 * platform — publishes its consolidated careers board through Greenhouse
 * at the bare `klaviyo` slug (no asymmetry; see Spec 045 § 10 D-05).
 *
 * Two structural deviations from the Affirm/Vercel template (both
 * isolated to this file):
 *
 *  - Fallback `jobUrl` uses the marketing-site careers proxy
 *    `https://www.klaviyo.com/careers/jobs?gh_jid=<id>` rather than
 *    either Greenhouse permalink subdomain (Spec 045 § 10 D-04).
 *  - Description cleanup is `stripHtmlTags(decodeHtmlEntities(content))`
 *    rather than the bare `stripHtmlTags(content)` form, because this
 *    tenant's `content` is HTML-entity-encoded (`&lt;p&gt;...`) rather
 *    than raw HTML tags (Spec 045 § 10 D-08).
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/klaviyo/jobs';

@SourcePlugin({
  site: Site.KLAVIYO,
  name: 'Klaviyo',
  category: 'company',
})
@Injectable()
export class KlaviyoService implements IScraper {
  private readonly logger = new Logger(KlaviyoService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Klaviyo: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        const title = listing.title ?? '';
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
        const id = `klaviyo-${jobId}`;

        const locationStr = listing.location?.name ?? null;
        const location = locationStr
          ? new LocationDto({ city: locationStr })
          : null;

        if (input.location && locationStr) {
          if (!locationStr.toLowerCase().includes(input.location.toLowerCase())) continue;
        }

        jobs.push(
          new JobPostDto({
            id,
            site: Site.KLAVIYO,
            title,
            companyName: 'Klaviyo',
            jobUrl:
              listing.absolute_url ??
              `https://www.klaviyo.com/careers/jobs?gh_jid=${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            department: listing.departments?.[0]?.name ?? null,
          }),
        );
      }

      this.logger.log(`Klaviyo: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Klaviyo scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
