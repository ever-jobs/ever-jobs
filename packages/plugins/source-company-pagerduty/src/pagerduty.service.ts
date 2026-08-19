import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * PagerDuty, Inc. — operator of the **dominant digital-
 * operations platform pioneered around the on-call alerting /
 * incident-response / DevOps-orchestration data model**
 * (founded by Andrew Miklas, Alex Solomon, and Baskar
 * Puvanathasan in 2009 in Toronto; public on the NYSE since
 * April 2019 IPO under ticker `PD` at ~$2.8B initial valuation;
 * ships PagerDuty's Operations Cloud (Incident Response,
 * Customer Service Ops, Process Automation — Rundeck acquired
 * October 2020 for $67.5M, AIOps), Event Intelligence, and
 * Service Standards across the digital-operations / on-call-
 * alerting / incident-response / observability segment —
 * alongside competitors Opsgenie, ServiceNow IT Operations
 * Management, Splunk On-Call, Datadog Incident Management,
 * and Squadcast — with a hybrid distributed workforce
 * concentrated across San Francisco (HQ), Toronto, Atlanta,
 * London, Sydney, Tokyo, and Remote across the United States,
 * Canada, the United Kingdom, the European Union, Australia,
 * and Japan) — publishes its consolidated careers board
 * through Greenhouse at the bare slug `pagerduty` (the
 * lowercase 9-byte slug; case-asymmetric vs the wire
 * `company_name === 'PagerDuty'` — TWO-cap PascalCase form
 * with caps at byte indices 0 and 5).
 *
 * **Zero structural deviations from the LaunchDarkly (Spec 114)
 * template** — making this the **twenty-first** Greenhouse-
 * only company-direct plugin in run-history to ship as a clean
 * re-spin. All five primary axes share with LaunchDarkly:
 *
 *   - **D-04 — wire-shape variant 2 (canonical Greenhouse host).**
 *     `https://job-boards.greenhouse.io/pagerduty/jobs/<id>`.
 *     **Thirty-seventh** plugin in the cohort to use variant 2.
 *
 *   - **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     **Seventy-third** plugin to apply D-08.
 *
 *   - **D-09 — brand-name trim omitted with PascalCase TWO-cap
 *     case-asymmetric wire form.** Wire `'PagerDuty'` byte-
 *     for-byte (9 bytes; case-asymmetric vs the lowercase
 *     9-byte slug `pagerduty` at TWO byte indices: 0
 *     (`P` vs `p`) and 5 (`D` vs `d`); both UPPERCASE on the
 *     wire). **Sixty-fourth cohort plugin to omit D-09**.
 *     **Fifth cohort observation of TWO-cap PascalCase D-09
 *     sub-axis** (after SoFi caps 0/2, StockX caps 0/5, xAI
 *     caps 0/2 with lowercase first letter, LaunchDarkly caps
 *     0/6). PagerDuty's caps at 0/5 **tie StockX for second-
 *     deepest second-cap** in the cohort (LaunchDarkly retains
 *     the deepest at 0/6).
 *
 *   - **D-10 — wire-title `.trim()` applied (trailing-pad form).**
 *     4 of 48 wire titles in the run-327 probe carry trailing
 *     ASCII-space padding (~8.3 % pad rate; e.g. `'Account
 *     Manager- San Francisco '`). All trailing-only. **Forty-
 *     first cohort plugin to apply D-10**.
 *
 *   - **D-11 — fully-clean department pass-through.** 0 of 48
 *     wire department names padded across 14 unique departments
 *     (`'Business Operations'`, `'Commercial Sales'`, `'Customer
 *     Success'`, `'Enterprise Sales'`, `'Legal'`, `'Marketing'`,
 *     `'Product Management'`, `'Professional Services'`,
 *     `'Renewals'`, `'Sales'`, plus 4 others — clean multi-
 *     token forms with internal whitespace). **Fifty-eighth
 *     cohort plugin** with fully-clean department pass-through.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/pagerduty/jobs';

@SourcePlugin({
  site: Site.PAGERDUTY,
  name: 'PagerDuty',
  category: 'company',
})
@Injectable()
export class PagerdutyService implements IScraper {
  private readonly logger = new Logger(PagerdutyService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`PagerDuty: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10 applied (trailing-pad form): 4/48 wire titles
        // padded (~8.3 %).
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
        const id = `pagerduty-${jobId}`;

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
            site: Site.PAGERDUTY,
            title,
            // D-09 omitted: PascalCase TWO-cap case-asymmetric
            // wire form 'PagerDuty'.
            companyName: listing.company_name ?? 'PagerDuty',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/pagerduty/jobs/${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            // D-11 omitted: 0/48 wire departments padded.
            department: listing.departments?.[0]?.name ?? null,
          }),
        );
      }

      this.logger.log(`PagerDuty: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`PagerDuty scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
