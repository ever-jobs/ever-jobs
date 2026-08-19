import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Buildkite Pty Ltd — CI/CD pipeline + test-execution +
 * distributed-build-orchestration vendor — publishes its consolidated
 * careers board through Greenhouse at the bare `buildkite` slug (no
 * asymmetry; see Spec 050 § 10 D-05).
 *
 * One structural deviation from the Mercury template, isolated to this
 * file:
 *
 *  - The wire `title` is `.trim()`ed before mapping to handle the
 *    trailing-space padding observed on a subset of Buildkite roles
 *    (e.g. `'Staff Engineer - Compute & Agents '`, `'Staff GTM Engineer '`,
 *    `'Technical Account Manager '`). Same approach Brex (Spec 047)
 *    introduced for its tenant — Buildkite is the second plugin in the
 *    cohort to apply the trim. See Spec 050 § 10 D-10.
 *
 * Description-cleanup pipeline `stripHtmlTags(decodeHtmlEntities(content))`
 * is identical to Mercury's because Buildkite's `content` is also HTML-
 * entity-encoded (`&lt;p&gt;...`) — confirmed via run #260's HTTP probe
 * of the live API where the first job's `content` starts with
 * `&lt;p&gt;At Buildkite, our mission is to unblock every developer on
 * the planet…` (Spec 050 § 10 D-08).
 *
 * Fallback `jobUrl` shape (`job-boards.greenhouse.io/buildkite/jobs/<id>`)
 * matches the wire `absolute_url` byte-for-byte — same as Vercel /
 * Affirm / Gusto / Mercury (Spec 050 § 10 D-04).
 *
 * Brand-name pin (`'Buildkite'`) matches the wire `company_name`
 * byte-for-byte — same as Mercury (Spec 050 § 10 D-09).
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/buildkite/jobs';

@SourcePlugin({
  site: Site.BUILDKITE,
  name: 'Buildkite',
  category: 'company',
})
@Injectable()
export class BuildkiteService implements IScraper {
  private readonly logger = new Logger(BuildkiteService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Buildkite: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

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
        const id = `buildkite-${jobId}`;

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
            site: Site.BUILDKITE,
            title,
            companyName: 'Buildkite',
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/buildkite/jobs/${listing.id}`,
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

      this.logger.log(`Buildkite: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Buildkite scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
