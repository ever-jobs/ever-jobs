import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Mercury Technologies, Inc. — SMB / startup business-banking +
 * spend-management vendor — publishes its consolidated careers board
 * through Greenhouse at the bare `mercury` slug (no asymmetry; see
 * Spec 049 § 10 D-05).
 *
 * One structural deviation from the Gusto template, isolated to this file:
 *
 *  - The wire `company_name` is the bare brand name `'Mercury'` (no
 *    legal-entity suffix), so the brand-name pin matches the wire
 *    byte-for-byte. Functionally identical to Gusto's pin, except the
 *    regression guard in the unit test is simpler — see Spec 049 § 10
 *    D-09.
 *
 * Description-cleanup pipeline `stripHtmlTags(decodeHtmlEntities(content))`
 * is identical to Gusto's because Mercury's `content` is also HTML-
 * entity-encoded (`&lt;p&gt;...`) — confirmed via run #259's HTTP probe
 * of the live API where the first job's `content` starts with
 * `&lt;p&gt;Railroads didn't change the world…` (Spec 049 § 10 D-08).
 *
 * Fallback `jobUrl` shape (`job-boards.greenhouse.io/mercury/jobs/<id>`)
 * matches the wire `absolute_url` byte-for-byte — same as Vercel /
 * Affirm / Gusto (Spec 049 § 10 D-04).
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/mercury/jobs';

@SourcePlugin({
  site: Site.MERCURY,
  name: 'Mercury',
  category: 'company',
})
@Injectable()
export class MercuryService implements IScraper {
  private readonly logger = new Logger(MercuryService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Mercury: fetching ${url}`);

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
        const id = `mercury-${jobId}`;

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
            site: Site.MERCURY,
            title,
            companyName: 'Mercury',
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/mercury/jobs/${listing.id}`,
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

      this.logger.log(`Mercury: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Mercury scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
