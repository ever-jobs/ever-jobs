import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Bobbie — operator of the **dominant European-style infant-
 * formula D2C SaaS platform pioneered around the FDA-compliant
 * organic / non-GMO / glyphosate-free clean-label baby-formula
 * data model** (founded by Laura Modi (formerly Airbnb) and
 * Sarah Hardy in 2018 in San Francisco; raised $100M+ across
 * Series A/B/C/D rounds led by Park West, North Sun Ventures,
 * Maveron, and Coatue at peak ~$525M valuation post-Series-D in
 * October 2023; ships a subscription-first organic infant-formula
 * direct-to-consumer brand across the parenting-CPG segment —
 * alongside competitors Kendamil, ByHeart, Serenity Kids, and
 * Earth's Best — with a hybrid distributed workforce concentrated
 * across San Francisco (HQ), Heath, OH (manufacturing plant
 * acquired from Perrigo in 2023), and Remote across the United
 * States) — publishes its consolidated careers board through
 * Greenhouse at the bare slug `bobbie` (the lowercase brand
 * name; case-symmetric with the wire `company_name === 'Bobbie'`
 * — see Spec 093 § 10 D-05).
 *
 * **Zero structural deviations from the Coursera (Spec 068)
 * template** — making this the **ninth** Greenhouse-only
 * company-direct plugin in run-history to ship as a clean re-
 * spin of a prior cohort plugin with no per-axis deviations
 * (after Coursera off Chime, Flexport off Faire, Glossier off
 * Flexport, Marqeta off Calendly, New Relic off Maven Clinic,
 * Scopely off Marqeta, Typeform-was-actually-one-deviation off
 * Lattice — corrected — and Adyen off Marqeta). All five
 * primary axes share with Coursera:
 *
 *   - **D-04 — wire-shape variant 2 (canonical Greenhouse
 *     host).** `https://job-boards.greenhouse.io/bobbie/jobs/<id>`.
 *     **Twenty-third** plugin in the cohort to use variant 2.
 *
 *   - **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     **Forty-ninth** plugin to apply D-08.
 *
 *   - **D-09 — brand-name trim omitted (case-symmetric).** Wire
 *     `company_name === 'Bobbie'` byte-for-byte (6 bytes — fully
 *     clean; 0 of 9 padded). Case-symmetric with the lowercase
 *     6-byte slug `bobbie`. **Forty-second cohort plugin to omit
 *     D-09**.
 *
 *   - **D-10 — wire-title `.trim()` omitted.** 0 of 9 wire
 *     titles in the run-303 probe carry whitespace padding.
 *     **Eighteenth cohort plugin to omit D-10**.
 *
 *   - **D-11 — fully-clean department pass-through.** 0 of 9
 *     wire department names padded (`'Operations'`, `'Brand &
 *     Marketing'`, `'Talent Pipeline'`, `'Commercial'`,
 *     `'Manufacturing'` — clean multi-token forms).
 *     **Thirty-seventh cohort plugin** with fully-clean
 *     department pass-through.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/bobbie/jobs';

@SourcePlugin({
  site: Site.BOBBIE,
  name: 'Bobbie',
  category: 'company',
})
@Injectable()
export class BobbieService implements IScraper {
  private readonly logger = new Logger(BobbieService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Bobbie: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10 omitted: 0/9 wire titles padded — pass through.
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
        const id = `bobbie-${jobId}`;

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
            site: Site.BOBBIE,
            title,
            // D-09 omitted: case-symmetric bare-brand wire.
            companyName: listing.company_name ?? 'Bobbie',
            // D-04: wire `absolute_url` flows through (variant 2
            // — canonical Greenhouse host); fallback uses the
            // same canonical variant-2 form.
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/bobbie/jobs/${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            // D-11 omitted: 0/9 wire departments padded.
            department: listing.departments?.[0]?.name ?? null,
          }),
        );
      }

      this.logger.log(`Bobbie: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Bobbie scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
