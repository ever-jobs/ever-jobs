import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Circle Internet Services, Inc. — continuous-integration-as-a-service /
 * hosted-Docker-CI vendor — publishes its consolidated careers board
 * through Greenhouse at the bare `circleci` slug (no asymmetry; see
 * Spec 051 § 10 D-05).
 *
 * One structural deviation from the Brex template, isolated to this
 * file:
 *
 *  - Fallback `jobUrl` mirrors the wire `absolute_url` shape
 *    `http://www.circleci.com/careers/jobs/<id>/?gh_jid=<id>` byte-for-
 *    byte — HTTP scheme (not HTTPS), with a `/careers/jobs/<id>/`
 *    path-with-trailing-slash before the query string. This is the
 *    seventh distinct wire-shape variant in the cohort and the first
 *    plugin to publish on the HTTP scheme. See Spec 051 § 10 D-04.
 *
 * Description-cleanup pipeline `stripHtmlTags(decodeHtmlEntities(content))`
 * is identical to Buildkite's because CircleCI's `content` is also HTML-
 * entity-encoded (`&lt;h3&gt;...&quot;...`) — confirmed via run #261's
 * HTTP probe of the live API where the first job's `content` starts
 * with `&lt;h3 data-start=&quot;545&quot; data-end=&quot;563&quot;&gt;
 * About the Role&lt;/h3&gt;` (Spec 051 § 10 D-08).
 *
 * Brand-name pin (`'CircleCI'`) matches the wire `company_name`
 * byte-for-byte — same as Mercury / Buildkite (Spec 051 § 10 D-09).
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/circleci/jobs';

@SourcePlugin({
  site: Site.CIRCLECI,
  name: 'CircleCI',
  category: 'company',
})
@Injectable()
export class CircleCIService implements IScraper {
  private readonly logger = new Logger(CircleCIService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`CircleCI: fetching ${url}`);

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
        const id = `circleci-${jobId}`;

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
            site: Site.CIRCLECI,
            title,
            companyName: 'CircleCI',
            jobUrl:
              listing.absolute_url ??
              `http://www.circleci.com/careers/jobs/${listing.id}/?gh_jid=${listing.id}`,
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

      this.logger.log(`CircleCI: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`CircleCI scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
