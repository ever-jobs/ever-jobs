import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Gusto, Inc. — small-business payroll / benefits / HR-platform vendor —
 * publishes its consolidated careers board through Greenhouse at the
 * bare `gusto` slug (no asymmetry; see Spec 048 § 10 D-05).
 *
 * Two structural deviations from the Affirm template (both isolated
 * to this file):
 *
 *  - Description cleanup runs `stripHtmlTags(decodeHtmlEntities(content))`
 *    rather than the bare `stripHtmlTags(content)` form Affirm uses,
 *    because Gusto's `content` is HTML-entity-encoded (`&lt;p&gt;...`)
 *    rather than raw HTML tags. Confirmed via run #258's HTTP probe of
 *    the live API where the first job's `content` starts with
 *    `&lt;div class=&quot;content-intro&quot;&gt;…` (Spec 048 § 10
 *    D-08). This is the **fourth** company-direct plugin to use the
 *    entity-decode-then-tag-strip pipeline (after Klaviyo, Duolingo,
 *    and Brex), and the **first** to combine that pipeline with the
 *    new `job-boards.greenhouse.io` permalink-subdomain wire-shape
 *    variant.
 *  - Emit the cleaned brand name `'Gusto'` rather than the wire
 *    `company_name` value `'Gusto, Inc.'`. Same approach Affirm
 *    uses for its `Affirm Holdings, Inc.` wire `company_name`
 *    (Spec 048 § 10 D-09).
 *
 * Fallback `jobUrl` shape (`job-boards.greenhouse.io/gusto/jobs/<id>`)
 * matches the wire `absolute_url` byte-for-byte, same as Vercel /
 * Affirm (Spec 048 § 10 D-04).
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/gusto/jobs';

@SourcePlugin({
  site: Site.GUSTO,
  name: 'Gusto',
  category: 'company',
})
@Injectable()
export class GustoService implements IScraper {
  private readonly logger = new Logger(GustoService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Gusto: fetching ${url}`);

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
        const id = `gusto-${jobId}`;

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
            site: Site.GUSTO,
            title,
            companyName: 'Gusto',
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/gusto/jobs/${listing.id}`,
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

      this.logger.log(`Gusto: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Gusto scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
