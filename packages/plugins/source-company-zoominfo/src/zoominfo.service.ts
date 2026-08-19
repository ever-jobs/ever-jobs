import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * ZoomInfo Technologies LLC — B2B go-to-market intelligence / sales-and-
 * marketing data platform vendor — publishes its consolidated careers
 * board through Greenhouse at the bare `zoominfo` slug (no asymmetry;
 * see Spec 057 § 10 D-05).
 *
 * Three structural deviations from the Toast (Spec 055) template:
 *
 *   1. **D-04 — variant 9 wire shape.** The fallback `jobUrl` shape is
 *      `https://www.zoominfo.com/careers?gh_jid=<id>` — the apex-www
 *      brand-domain marketing-site shape with `?gh_jid=<id>` query-
 *      param-only listing identification (no `<id>` in the path).
 *      Distinct from Toast's variant 8 sub-brand careers-subdomain
 *      `https://careers.toasttab.com/jobs?gh_jid=<id>`. ZoomInfo is the
 *      **first plugin in the cohort to use the apex-www brand-domain
 *      `?gh_jid=<id>` shape** (the apex-www subdomain on the corporate
 *      brand domain `zoominfo.com`).
 *
 *   2. **D-09 — brand-name trim of legal-entity suffix.** ZoomInfo's
 *      wire `company_name` is `'ZoomInfo Technologies LLC'` (the
 *      registered Delaware LLC name with the space-separated
 *      `Technologies LLC` suffix). The plugin pins the brand name
 *      `'ZoomInfo'` as a string literal so downstream consumers see the
 *      cosmetic brand rather than the legal-entity suffix. ZoomInfo is
 *      the **third plugin in the cohort to apply a brand-name trim**
 *      (after Affirm `Spec 044 § 10 D-06` `'Affirm, Inc.'` → `'Affirm'`
 *      and Gusto `Spec 048 § 10 D-09` `'Gusto, Inc.'` → `'Gusto'`) and
 *      the **first to clean a space-separated suffix** rather than a
 *      comma-separated one.
 *
 *   3. **D-10 — wire-title `.trim()`.** A subset of ZoomInfo wire
 *      titles carry trailing ASCII-space padding (5 of 82 titles in
 *      the run-267 probe — e.g. `'Account Manager, Enterprise Growth '`).
 *      The plugin applies `.trim()` to the wire `title` before the
 *      empty-title skip check AND before the `searchTerm` filter AND
 *      before the `JobPostDto` emit, so the emitted `title` is the
 *      trimmed form. Third plugin in the cohort to apply a wire-title
 *      trim (after Brex `Spec 047 § 10 D-10` and Buildkite `Spec 050 §
 *      10 D-10`).
 *
 * Description-cleanup pipeline `stripHtmlTags(decodeHtmlEntities(content))`
 * is identical to Toast's because ZoomInfo's `content` is also HTML-
 * entity-encoded (`&lt;div class=&quot;content-intro&quot;&gt;...`) —
 * confirmed via run #267's HTTP probe of the live API where the first
 * job's `content` starts with `&lt;div class=&quot;content-intro&quot;
 * &gt;&lt;p&gt;ZoomInfo is where careers accelerate.` (Spec 057 § 10
 * D-08). The wire payload also includes the named entities `&quot;`
 * (decodes to `"`) and `&rsquo;` (decodes to `'` U+2019) and the
 * numeric entity `&#39;` (decodes to apostrophe). This is the
 * **thirteenth** company-direct plugin in the cohort to use the
 * entity-decode-then-tag-strip description pipeline.
 *
 * Department pass-through preserves the numeric-code-prefixed format
 * ZoomInfo's tenant uses (e.g. `'801 Client Services - Support'`,
 * `'898 Corporate Engineering - G&A - Enterprise Technologies'`,
 * `'820 R&G - Account Managers'`) byte-for-byte (Spec 057 § 10 D-11) —
 * ZoomInfo is the first plugin in the cohort to ship a fixture with
 * numeric-code-prefixed department names.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/zoominfo/jobs';

@SourcePlugin({
  site: Site.ZOOMINFO,
  name: 'ZoomInfo',
  category: 'company',
})
@Injectable()
export class ZoomInfoService implements IScraper {
  private readonly logger = new Logger(ZoomInfoService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`ZoomInfo: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10: trim wire title before downstream filters and emit.
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
        const id = `zoominfo-${jobId}`;

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
            site: Site.ZOOMINFO,
            title,
            // D-09: trim wire `'ZoomInfo Technologies LLC'` to brand
            // `'ZoomInfo'` via string-literal pin. Third cohort plugin
            // to apply a brand-name trim, first with a space-separated
            // legal-entity suffix.
            companyName: 'ZoomInfo',
            jobUrl:
              listing.absolute_url ??
              `https://www.zoominfo.com/careers?gh_jid=${listing.id}`,
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

      this.logger.log(`ZoomInfo: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`ZoomInfo scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
