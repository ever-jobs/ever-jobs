import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * LaunchDarkly, Inc. — operator of the **dominant feature-
 * management / experimentation platform pioneered around the
 * runtime-flag-evaluation-as-a-service data model** (founded by
 * Edith Harbaugh, John Kodumal, and Ian Henderson in 2014 in
 * Oakland, California; raised ~$330M across rounds at peak ~$3B
 * valuation in 2021 led by Lightspeed Venture Partners; ships
 * LaunchDarkly's feature-flag platform, experimentation engine,
 * and observability tooling across the feature-management /
 * release-orchestration / progressive-delivery segment —
 * alongside competitors Optimizely, Split.io, ConfigCat,
 * Statsig, and AWS AppConfig — with a hybrid distributed
 * workforce concentrated across Oakland (HQ), New York, San
 * Francisco, London, and Remote across the United States, the
 * United Kingdom, and the European Union) — publishes its
 * consolidated careers board through Greenhouse at the bare
 * slug `launchdarkly` (the lowercase 12-byte slug; case-
 * asymmetric vs the wire `company_name === 'LaunchDarkly'` —
 * TWO-cap PascalCase form with caps at byte indices 0 and 6).
 *
 * **One structural deviation from the PlanetScale (Spec 100)
 * template** — D-10 applied (PlanetScale 0/6 padded omitted;
 * LaunchDarkly 3/45 padded ~6.7 % applied). All other axes
 * share with PlanetScale: D-04 variant 2 (canonical Greenhouse
 * host), D-08 entity-decode-then-tag-strip, D-09 omitted with
 * PascalCase case-asymmetric wire form, D-11 omitted (departments
 * fully clean).
 *
 *   - **D-04 — wire-shape variant 2 (canonical Greenhouse host).**
 *     `https://job-boards.greenhouse.io/launchdarkly/jobs/<id>`.
 *     **Thirty-fifth** plugin in the cohort to use variant 2.
 *
 *   - **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     **Seventieth** plugin to apply D-08.
 *
 *   - **D-09 — brand-name trim omitted with PascalCase TWO-cap
 *     case-asymmetric wire form.** Wire `'LaunchDarkly'` byte-
 *     for-byte (12 bytes; case-asymmetric vs the lowercase
 *     12-byte slug `launchdarkly` at TWO byte indices: 0
 *     (`L` vs `l`) and 6 (`D` vs `d`); both UPPERCASE on the
 *     wire). **Sixty-first cohort plugin to omit D-09**.
 *     **Fourth cohort observation of TWO-cap PascalCase D-09
 *     sub-axis** (after SoFi caps 0/2, StockX caps 0/5, xAI
 *     caps 0/2 with lowercase first letter). LaunchDarkly's
 *     caps at 0/6 are the **deepest second-cap** observed in
 *     the cohort to date (StockX previously held the deepest-
 *     second-cap at index 5).
 *
 *   - **D-10 — wire-title `.trim()` applied (trailing-pad form).**
 *     3 of 45 wire titles in the run-324 probe carry trailing
 *     ASCII-space padding (~6.7 % pad rate; e.g. `'Enterprise
 *     Account Executive - Germany '`). All trailing-only.
 *     **Thirty-eighth cohort plugin to apply D-10**.
 *
 *   - **D-11 — fully-clean department pass-through.** 0 of 45
 *     wire department names padded across 17 unique departments
 *     (`'AI Engineering'`, `'CEO Administration'`, `'Core
 *     Engineering'`, `'Customer Success'`, `'Finance'`, `'IT'`,
 *     `'Legal'`, `'Marketing'`, `'Measure Engineering'`,
 *     `'Partnerships'`, plus 7 others — clean multi-token forms
 *     with internal whitespace and acronym suffixes).
 *     **Fifty-fifth cohort plugin** with fully-clean department
 *     pass-through.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/launchdarkly/jobs';

@SourcePlugin({
  site: Site.LAUNCHDARKLY,
  name: 'LaunchDarkly',
  category: 'company',
})
@Injectable()
export class LaunchdarklyService implements IScraper {
  private readonly logger = new Logger(LaunchdarklyService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`LaunchDarkly: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10 applied (trailing-pad form): 3/45 wire titles
        // padded (~6.7 %).
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
        const id = `launchdarkly-${jobId}`;

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
            site: Site.LAUNCHDARKLY,
            title,
            // D-09 omitted: PascalCase TWO-cap case-asymmetric
            // wire form 'LaunchDarkly'.
            companyName: listing.company_name ?? 'LaunchDarkly',
            // D-04: wire `absolute_url` flows through (variant 2
            // — canonical Greenhouse host); fallback uses same
            // canonical form.
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/launchdarkly/jobs/${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            // D-11 omitted: 0/45 wire departments padded.
            department: listing.departments?.[0]?.name ?? null,
          }),
        );
      }

      this.logger.log(`LaunchDarkly: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`LaunchDarkly scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
