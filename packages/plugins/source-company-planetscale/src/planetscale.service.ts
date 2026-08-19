import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * PlanetScale, Inc. — operator of the **dominant Vitess-based
 * MySQL-compatible serverless-database platform pioneered around
 * the schema-branching / non-blocking-migration / horizontally-
 * scalable database-as-a-service data model** (founded by Sam
 * Lambert, Jiten Vaidya, and Sugu Sougoumarane in 2018 in
 * California, all three former YouTube / Slack engineers who
 * created the open-source Vitess clustering layer that
 * originally scaled YouTube's MySQL footprint; raised ~$166M
 * across rounds at peak ~$1.1B valuation in May 2022 led by
 * Kleiner Perkins; ships PlanetScale (MySQL serverless),
 * PlanetScale for Postgres (Postgres serverless preview), and
 * the Boost / Insights observability stack across the
 * managed-MySQL / serverless-database segment — alongside
 * competitors Neon, Aiven, Supabase, AWS Aurora Serverless,
 * and Cockroach Labs — with a fully-distributed remote-first
 * workforce concentrated in the United States) — publishes its
 * consolidated careers board through Greenhouse at the bare
 * slug `planetscale` (the lowercase concatenated brand-name;
 * case-symmetric with the wire `company_name === 'PlanetScale'`
 * PascalCase concat — same byte-count (11 bytes) but byte-
 * distinct via case alone at byte index 6 — see Spec 101 § 10
 * D-05).
 *
 * **Zero structural deviations from the Coursera (Spec 068)
 * template** — making this the **thirteenth** Greenhouse-only
 * company-direct plugin in run-history to ship as a clean re-
 * spin (after Coursera off Chime, Flexport off Faire, Glossier
 * off Flexport, Marqeta off Calendly, New Relic off Maven
 * Clinic, Scopely off Marqeta, Adyen off Marqeta, Bobbie off
 * Coursera, Cerebral off Adyen, Misfits Market off New Relic,
 * Monzo off Adyen, plus a corrected count). All five primary
 * axes share with Coursera:
 *
 *   - **D-04 — wire-shape variant 2 (canonical Greenhouse
 *     host).** `https://job-boards.greenhouse.io/planetscale/jobs/<id>`.
 *     **Twenty-eighth** plugin in the cohort to use variant 2.
 *
 *   - **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     **Fifty-seventh** plugin to apply D-08.
 *
 *   - **D-09 — brand-name trim omitted with PascalCase same-
 *     byte-count case-asymmetry.** Wire `company_name ===
 *     'PlanetScale'` byte-for-byte (11 bytes, PascalCase concat;
 *     same byte-count as the lowercase 11-byte slug `planetscale`
 *     but byte-distinct via case alone at byte index 6 — `'S'`
 *     vs `'s'`). Same case-only-asymmetric same-byte-count
 *     shape as DataCamp (Spec 075) and HelloFresh (Spec 097).
 *     0 of 6 padded. **Fiftieth cohort plugin to omit D-09**.
 *
 *   - **D-10 — wire-title `.trim()` omitted.** 0 of 6 wire
 *     titles in the run-311 probe carry whitespace padding
 *     (`'Brand Designer'`, `'Developer Educator'`, `'Enterprise
 *     Support Engineer'`, `'Software Engineer - Information
 *     Security'`, `'Software Engineer - Infrastructure'`,
 *     `'Solutions Engineer'`). **Twentieth cohort plugin to
 *     omit D-10**.
 *
 *   - **D-11 — fully-clean department pass-through.** 0 of 6
 *     wire department names padded (`'Customer Engineering'`,
 *     `'Engineering'`, `'Marketing'`, `'Sales'` — clean multi-
 *     token forms). **Forty-third cohort plugin** with fully-
 *     clean department pass-through.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/planetscale/jobs';

@SourcePlugin({
  site: Site.PLANETSCALE,
  name: 'PlanetScale',
  category: 'company',
})
@Injectable()
export class PlanetScaleService implements IScraper {
  private readonly logger = new Logger(PlanetScaleService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`PlanetScale: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10 omitted: 0/6 wire titles padded — pass through.
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
        const id = `planetscale-${jobId}`;

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
            site: Site.PLANETSCALE,
            title,
            // D-09 omitted: PascalCase case-asymmetric wire form.
            companyName: listing.company_name ?? 'PlanetScale',
            // D-04: wire `absolute_url` flows through (variant 2
            // — canonical Greenhouse host); fallback uses the
            // same canonical variant-2 form.
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/planetscale/jobs/${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            // D-11 omitted: 0/6 wire departments padded.
            department: listing.departments?.[0]?.name ?? null,
          }),
        );
      }

      this.logger.log(`PlanetScale: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`PlanetScale scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
