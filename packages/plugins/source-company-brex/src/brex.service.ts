import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Brex Inc. — fintech corporate-card / spend-management / business-
 * banking vendor — publishes its consolidated careers board through
 * Greenhouse at the bare `brex` slug (no asymmetry; see Spec 047 § 10
 * D-05).
 *
 * Two structural deviations from the Duolingo template (both isolated
 * to this file):
 *
 *  - Fallback `jobUrl` uses the apex marketing-site careers shape
 *    `https://www.brex.com/careers/<id>?gh_jid=<id>` — the **fifth**
 *    distinct wire-shape variant in the company-direct cohort, where
 *    the Greenhouse job id is embedded BOTH as a path segment AND as
 *    a `?gh_jid=<id>` query parameter on the apex `www.` domain
 *    (Spec 047 § 10 D-04).
 *  - Wire `title` is trimmed of leading/trailing whitespace before
 *    mapping to `JobPostDto`. Brex's tenant pads some titles with
 *    surrounding ASCII spaces (` Account Executive, E-Commerce ` was
 *    the wire shape on the first listing observed during the run #257
 *    probe). Other plugins in the cohort do not need this defence
 *    because their upstream wire payload does not pad titles, but the
 *    trim is a cheap forward-compatible safety pass that costs nothing
 *    if the upstream is already clean (Spec 047 § 10 D-09).
 *
 * Description cleanup is `stripHtmlTags(decodeHtmlEntities(content))`
 * — same pipeline Duolingo and Klaviyo use (Spec 047 § 10 D-08), because
 * Brex's `content` is HTML-entity-encoded (`&lt;p&gt;...`) rather than
 * raw HTML tags.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/brex/jobs';

@SourcePlugin({
  site: Site.BREX,
  name: 'Brex',
  category: 'company',
})
@Injectable()
export class BrexService implements IScraper {
  private readonly logger = new Logger(BrexService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Brex: fetching ${url}`);

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
        const id = `brex-${jobId}`;

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
            site: Site.BREX,
            title,
            companyName: 'Brex',
            jobUrl:
              listing.absolute_url ??
              `https://www.brex.com/careers/${listing.id}?gh_jid=${listing.id}`,
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

      this.logger.log(`Brex: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Brex scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
