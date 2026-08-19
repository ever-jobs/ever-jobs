import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Postman, Inc. — the dominant API development platform vendor — publishes
 * its consolidated careers board through Greenhouse at the bare `postman`
 * slug (no asymmetry; see Spec 054 § 10 D-05).
 *
 * Zero structural deviations from the Netlify (Spec 053) template.
 *
 * Description-cleanup pipeline `stripHtmlTags(decodeHtmlEntities(content))`
 * is identical to Netlify's because Postman's `content` is also HTML-
 * entity-encoded (`&lt;div class=&quot;content-intro&quot;&gt;...`) —
 * confirmed via run #264's HTTP probe of the live API where the first
 * job's `content` starts with
 * `&lt;div class=&quot;content-intro&quot;&gt;&lt;h2&gt;&lt;strong&gt;
 * Who Are We?&lt;/strong&gt;&lt;/h2&gt;` (Spec 054 § 10 D-08).
 *
 * Fallback `jobUrl` shape (`job-boards.greenhouse.io/postman/jobs/<id>`)
 * matches the wire `absolute_url` byte-for-byte — same as Vercel /
 * Affirm / Gusto / Mercury / Buildkite / Netlify (Spec 054 § 10 D-04).
 * This is the seventh plugin in the cohort to use variant 2 (the
 * US-region permalink subdomain).
 *
 * Brand-name pin (`'Postman'`) matches the wire `company_name`
 * byte-for-byte — same as Mercury / Buildkite / CircleCI / Ramp Network /
 * Netlify (Spec 054 § 10 D-09).
 *
 * The wire payload begins with a `<div class="content-intro">` recruiter-
 * blurb wrapper that the entity-decode-then-tag-strip pipeline
 * neutralises into clean prose (Spec 054 § 10 D-11). The plugin does not
 * apply a per-source content-intro filter; the surviving prose is part
 * of the natural job-description body.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/postman/jobs';

@SourcePlugin({
  site: Site.POSTMAN,
  name: 'Postman',
  category: 'company',
})
@Injectable()
export class PostmanService implements IScraper {
  private readonly logger = new Logger(PostmanService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Postman: fetching ${url}`);

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
        const id = `postman-${jobId}`;

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
            site: Site.POSTMAN,
            title,
            companyName: 'Postman',
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/postman/jobs/${listing.id}`,
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

      this.logger.log(`Postman: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Postman scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
