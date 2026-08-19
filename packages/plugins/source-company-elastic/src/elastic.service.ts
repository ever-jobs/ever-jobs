import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Elastic NV — search / observability / security analytics platform
 * vendor (developer of the Elastic Stack: Elasticsearch, Kibana,
 * Logstash, Beats; NYSE-listed under ticker ESTC) — publishes its
 * consolidated careers board through Greenhouse at the bare `elastic`
 * slug (no asymmetry; see Spec 060 § 10 D-05).
 *
 * One structural deviation from the Attentive (Spec 058) template:
 *
 *   1. **D-04 — wire-shape variant 11 fallback URL.** Elastic's tenant
 *      publishes its `absolute_url` on a **vanity-domain** shape
 *      `https://jobs.elastic.co/jobs?gh_jid=<id>&gh_jid=<id>` — the
 *      custom `jobs.elastic.co` host hosting the rendered Greenhouse
 *      iframe; the `gh_jid=<id>&gh_jid=<id>` duplicate query parameter
 *      is the wire form Greenhouse emits for vanity-domain tenants —
 *      the second `gh_jid` reflects the same listing id as the first,
 *      repeated literally on the wire. First plugin in the cohort to
 *      use variant 11 (distinct from variant 1's `boards.greenhouse.io
 *      /<slug>` apex shape, variant 2's modern US-region permalink
 *      subdomain `job-boards.greenhouse.io/<slug>/jobs/<id>`, and
 *      variant 10's legacy hosted-board apex `boards.greenhouse.io/
 *      <slug>/jobs/<id>?gh_jid=<id>` shape).
 *
 * Description-cleanup pipeline `stripHtmlTags(decodeHtmlEntities(content))`
 * is identical to Attentive's because Elastic's `content` is also HTML-
 * entity-encoded (`&lt;div class=&quot;content-intro&quot;&gt;&lt;p&gt;
 * Elastic, the Search AI Company...`) — confirmed via run #270's HTTP
 * probe of the live API where 193 of 193 wire jobs carry HTML entities
 * and 0 of 193 carry raw HTML tags (Spec 060 § 10 D-08). This is the
 * **sixteenth** company-direct plugin in the cohort to use the
 * entity-decode-then-tag-strip description pipeline.
 *
 * Wire `company_name` is `'Elastic'` byte-for-byte (no legal-entity
 * suffix on the wire — confirmed via run-270 probe where 193 of 193
 * wire jobs carry `company_name === 'Elastic'`); the plugin reads
 * `listing.company_name` directly without a string-literal pin (D-09
 * omitted).
 *
 * Wire `title` IS trimmed via `.trim()` because 16 of 193 wire titles
 * in the run-270 probe carry trailing ASCII-space padding — `'Account
 * Executive '`, `'Consulting Architect, Public Sector - Netherlands '`,
 * `'Customer Architect - EMEA Central '`, `'Enterprise Account
 * Executive '`, etc. (8.3 % of the open roles). Fifth plugin in the
 * cohort to apply D-10 (after Brex `Spec 047 § 10 D-10`, Buildkite
 * `Spec 050 § 10 D-10`, ZoomInfo `Spec 057 § 10 D-10`, and Attentive
 * `Spec 058 § 10 D-10`).
 *
 * Department pass-through preserves Elastic's compound `' - '`-
 * separated department names that scope region within line-of-business
 * (`'Sales - EMEA - UKI'`, `'Sales - APJ - India'`, `'Customer
 * Architects - EMEA'`, `'Consulting - EMEA'`, `'SA - Global'`,
 * `'Strategic Sourcing'`, etc.) byte-for-byte (Spec 060 § 10 D-11).
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/elastic/jobs';

@SourcePlugin({
  site: Site.ELASTIC,
  name: 'Elastic',
  category: 'company',
})
@Injectable()
export class ElasticService implements IScraper {
  private readonly logger = new Logger(ElasticService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Elastic: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10: trim trailing pad bytes off `listing.title` before
        // downstream filters and emit. 16 of 193 wire titles in the
        // run-270 probe carry trailing ASCII-space padding.
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
        const id = `elastic-${jobId}`;

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
            site: Site.ELASTIC,
            title,
            companyName: listing.company_name ?? 'Elastic',
            // D-04: variant-11 vanity-domain fallback —
            // `jobs.elastic.co/jobs?gh_jid=<id>&gh_jid=<id>` with the
            // duplicate `gh_jid` query parameter the second of which
            // reflects the same listing id as the first, repeated
            // literally on the wire.
            jobUrl:
              listing.absolute_url ??
              `https://jobs.elastic.co/jobs?gh_jid=${listing.id}&gh_jid=${listing.id}`,
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

      this.logger.log(`Elastic: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Elastic scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
