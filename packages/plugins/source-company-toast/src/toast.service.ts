import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Toast, Inc. — restaurant point-of-sale and management platform vendor —
 * publishes its consolidated careers board through Greenhouse at the bare
 * `toast` slug (no asymmetry; see Spec 055 § 10 D-05).
 *
 * One structural deviation from the Postman (Spec 054) template: the
 * fallback `jobUrl` shape uses variant 8 (the careers-subdomain on a
 * sub-brand product domain `careers.toasttab.com/jobs?gh_jid=<id>`)
 * rather than variant 2 (`job-boards.greenhouse.io/<slug>/jobs/<id>`).
 * Toast is the **first plugin in the cohort to use a sub-brand product
 * domain** (`toasttab.com`) rather than a slug-name brand domain
 * (`toast.com`) — the operating product domain pre-dates the corporate-
 * brand consolidation onto `toast.com`.
 *
 * Description-cleanup pipeline `stripHtmlTags(decodeHtmlEntities(content))`
 * is identical to Postman's because Toast's `content` is also HTML-
 * entity-encoded (`&lt;p&gt;...`) — confirmed via run #265's HTTP probe
 * of the live API where the first job's `content` starts with
 * `&lt;p&gt;Our mission is to empower the global restaurant community...`
 * (Spec 055 § 10 D-08). The wire payload also includes the named entity
 * `&amp;nbsp;` (which decodes to a non-breaking space U+00A0) and the
 * numeric entity `&#39;` (which decodes to an apostrophe).
 *
 * Brand-name pin (`'Toast'`) matches the wire `company_name`
 * byte-for-byte — same as Postman / Netlify / Mercury / Buildkite /
 * CircleCI / Ramp Network (Spec 055 § 10 D-09).
 *
 * Department pass-through preserves the colon-separated nested-path
 * format Toast's tenant uses (e.g. `'Sales : International : Horizon 2'`,
 * `'R & D : Engineering : Retail'`) byte-for-byte (Spec 055 § 10 D-11) —
 * Toast is the first plugin in the cohort to ship a fixture with
 * colon-separated nested-path department names.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/toast/jobs';

@SourcePlugin({
  site: Site.TOAST,
  name: 'Toast',
  category: 'company',
})
@Injectable()
export class ToastService implements IScraper {
  private readonly logger = new Logger(ToastService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Toast: fetching ${url}`);

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
        const id = `toast-${jobId}`;

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
            site: Site.TOAST,
            title,
            companyName: 'Toast',
            jobUrl:
              listing.absolute_url ??
              `https://careers.toasttab.com/jobs?gh_jid=${listing.id}`,
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

      this.logger.log(`Toast: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Toast scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
