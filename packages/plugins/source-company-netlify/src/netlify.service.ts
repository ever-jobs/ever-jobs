import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Netlify, Inc. — edge-deployed Jamstack hosting + serverless-functions
 * vendor — publishes its consolidated careers board through Greenhouse at
 * the bare `netlify` slug (no asymmetry; see Spec 053 § 10 D-05).
 *
 * Zero structural deviations from the Buildkite (Spec 050) template.
 *
 * Description-cleanup pipeline `stripHtmlTags(decodeHtmlEntities(content))`
 * is identical to Buildkite's because Netlify's `content` is also HTML-
 * entity-encoded (`&lt;p&gt;...`) — confirmed via run #263's HTTP probe
 * of the live API where the first job's `content` starts with
 * `&lt;p&gt;&lt;strong&gt;About the Team:&lt;/strong&gt;&lt;/p&gt;`
 * (Spec 053 § 10 D-08). The wire payload also includes the named entity
 * `&amp;nbsp;` (which decodes to a non-breaking space U+00A0) and the
 * numeric entity `&#39;` (which decodes to an apostrophe).
 *
 * Fallback `jobUrl` shape (`job-boards.greenhouse.io/netlify/jobs/<id>`)
 * matches the wire `absolute_url` byte-for-byte — same as Vercel /
 * Affirm / Gusto / Mercury / Buildkite (Spec 053 § 10 D-04). This is the
 * sixth plugin in the cohort to use variant 2 (the US-region permalink
 * subdomain).
 *
 * Brand-name pin (`'Netlify'`) matches the wire `company_name`
 * byte-for-byte — same as Mercury / Buildkite / CircleCI / Ramp Network
 * (Spec 053 § 10 D-09).
 *
 * Department-name pass-through preserves literal ASCII ampersands like
 * `R&D` and `G&A` byte-for-byte (Spec 053 § 10 D-11) — Netlify is the
 * first plugin in the cohort to ship a fixture with an ampersand-bearing
 * department name.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/netlify/jobs';

@SourcePlugin({
  site: Site.NETLIFY,
  name: 'Netlify',
  category: 'company',
})
@Injectable()
export class NetlifyService implements IScraper {
  private readonly logger = new Logger(NetlifyService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Netlify: fetching ${url}`);

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
        const id = `netlify-${jobId}`;

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
            site: Site.NETLIFY,
            title,
            companyName: 'Netlify',
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/netlify/jobs/${listing.id}`,
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

      this.logger.log(`Netlify: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Netlify scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
