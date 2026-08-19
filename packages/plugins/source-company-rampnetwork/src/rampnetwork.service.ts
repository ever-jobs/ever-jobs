import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Ramp Swaps Ltd — Web3 fiat-to-crypto onramp toolkit vendor — publishes
 * its consolidated careers board through Greenhouse at the bare
 * `rampnetwork` slug (no asymmetry beyond the standard whitespace-collapse
 * Greenhouse applies to multi-word brand names; see Spec 052 § 10 D-05).
 *
 * One structural deviation from the Buildkite template, isolated to this
 * file:
 *
 *  - Fallback `jobUrl` mirrors the wire `absolute_url` shape
 *    `https://job-boards.eu.greenhouse.io/rampnetwork/jobs/<id>` byte-for-
 *    byte — the EU-region permalink subdomain `job-boards.eu.greenhouse.io`
 *    rather than the US-region `job-boards.greenhouse.io` Buildkite /
 *    Mercury / Gusto / Affirm / Vercel use. This is the sixth distinct
 *    wire-shape variant in the cohort and the first plugin to publish
 *    on the EU-region subdomain. See Spec 052 § 10 D-04.
 *
 * Description-cleanup pipeline `stripHtmlTags(decodeHtmlEntities(content))`
 * is identical to Buildkite's because Ramp Network's `content` is also
 * HTML-entity-encoded (`&lt;div&gt;...&quot;...`) — confirmed via run
 * #262's HTTP probe of the live API where the first job's `content`
 * starts with `&lt;div class=&quot;content-intro&quot;&gt;&lt;h2&gt;
 * &lt;strong&gt;Join the Web3 revolution at Ramp Network!&lt;/strong&gt;
 * &lt;/h2&gt;` (Spec 052 § 10 D-08).
 *
 * Brand-name pin (`'Ramp Network'`) matches the wire `company_name`
 * byte-for-byte — same as Buildkite / Mercury / CircleCI; first plugin
 * in the cohort to pin a multi-word brand-name string literal containing
 * an inter-word ASCII space (Spec 052 § 10 D-09).
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/rampnetwork/jobs';

@SourcePlugin({
  site: Site.RAMPNETWORK,
  name: 'Ramp Network',
  category: 'company',
})
@Injectable()
export class RampNetworkService implements IScraper {
  private readonly logger = new Logger(RampNetworkService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Ramp Network: fetching ${url}`);

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
        const id = `rampnetwork-${jobId}`;

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
            site: Site.RAMPNETWORK,
            title,
            companyName: 'Ramp Network',
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.eu.greenhouse.io/rampnetwork/jobs/${listing.id}`,
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

      this.logger.log(`Ramp Network: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Ramp Network scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
