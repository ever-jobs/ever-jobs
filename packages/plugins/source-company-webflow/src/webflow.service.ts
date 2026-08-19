import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Webflow, Inc. — AI-native Digital Experience Platform / visual website
 * builder vendor — publishes its consolidated careers board through
 * Greenhouse at the bare `webflow` slug (no asymmetry; see Spec 056 § 10
 * D-05).
 *
 * Zero structural deviations from the Postman (Spec 054) template.
 *
 * Description-cleanup pipeline `stripHtmlTags(decodeHtmlEntities(content))`
 * is identical to Postman's because Webflow's `content` is also HTML-
 * entity-encoded (`&lt;p&gt;...`) — confirmed via run #266's HTTP probe
 * of the live API where the first job's `content` starts with
 * `&lt;p&gt;At Webflow, we&rsquo;re building the world&rsquo;s leading
 * AI-native Digital Experience Platform` (Spec 056 § 10 D-08). The wire
 * payload also includes the named entity `&rsquo;` (which decodes to a
 * right single quotation mark U+2019).
 *
 * Fallback `jobUrl` shape (`job-boards.greenhouse.io/webflow/jobs/<id>`)
 * matches the wire `absolute_url` byte-for-byte — same as Vercel /
 * Affirm / Gusto / Mercury / Buildkite / Netlify / Postman (Spec 056 §
 * 10 D-04). This is the eighth plugin in the cohort to use variant 2
 * (the US-region permalink subdomain).
 *
 * Brand-name pin (`'Webflow'`) matches the wire `company_name`
 * byte-for-byte — same as Postman / Netlify / Mercury / Buildkite /
 * CircleCI / Ramp Network / Toast (Spec 056 § 10 D-09).
 *
 * Location pass-through preserves Webflow's semicolon-separated
 * multi-region remote-location format (e.g. `'CA Remote (BC & ON only);
 * U.K. / Ireland Remote; U.S. Remote'`) byte-for-byte (Spec 056 § 10
 * D-11) — Webflow is the first plugin in the cohort to ship a fixture
 * with semicolon-separated multi-region location names.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/webflow/jobs';

@SourcePlugin({
  site: Site.WEBFLOW,
  name: 'Webflow',
  category: 'company',
})
@Injectable()
export class WebflowService implements IScraper {
  private readonly logger = new Logger(WebflowService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Webflow: fetching ${url}`);

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
        const id = `webflow-${jobId}`;

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
            site: Site.WEBFLOW,
            title,
            companyName: 'Webflow',
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/webflow/jobs/${listing.id}`,
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

      this.logger.log(`Webflow: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Webflow scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
