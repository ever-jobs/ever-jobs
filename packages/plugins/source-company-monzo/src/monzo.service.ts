import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Monzo Bank Ltd. — operator of the **dominant UK challenger-
 * bank platform pioneered around the mobile-first / app-only
 * personal-current-account data model** (founded by Tom
 * Blomfield, Jonas Huckestein, Jason Bates, Paul Rippon, and
 * Gary Dolman in February 2015 in London (originally as Mondo;
 * rebranded to Monzo in August 2016 after a trademark dispute);
 * authorised as a UK bank by the PRA in April 2017; raised
 * ~£1.1B across rounds at peak ~£4.5B / $5.9B valuation in
 * March 2024 led by CapitalG / Alphabet, GIC, and HongShan
 * (formerly Sequoia China); operates a US-domestic Monzo Inc.
 * subsidiary launched in 2022; ships current accounts, joint
 * accounts, business banking, savings pots, lending products,
 * and the Monzo Plus / Monzo Premium subscription tiers across
 * the UK challenger-bank segment — alongside competitors
 * Starling Bank, Revolut, Chase UK / JPMorgan, and N26 — with
 * a hybrid distributed workforce concentrated across London
 * (HQ), Cardiff, Barcelona, Dublin, Las Vegas, and Remote
 * across the United Kingdom, the European Union, and the
 * United States) — publishes its consolidated careers board
 * through Greenhouse at the bare slug `monzo` (the lowercase
 * brand-name; case-symmetric with the wire `company_name ===
 * 'Monzo'` — see Spec 099 § 10 D-05).
 *
 * **Zero structural deviations from the Adyen (Spec 090)
 * template** — making this the **twelfth** Greenhouse-only
 * company-direct plugin in run-history to ship as a clean re-
 * spin (after Coursera, Flexport, Glossier, Marqeta, New Relic,
 * Scopely, Adyen, Bobbie, Cerebral, Misfits Market, plus a
 * corrected count). All five primary axes share with Adyen:
 *
 *   - **D-04 — wire-shape variant 2 (canonical Greenhouse
 *     host).** `https://job-boards.greenhouse.io/monzo/jobs/<id>`.
 *     **Twenty-seventh** plugin in the cohort to use variant 2.
 *
 *   - **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     **Fifty-fifth** plugin to apply D-08.
 *
 *   - **D-09 — brand-name trim omitted (case-symmetric).** Wire
 *     `company_name === 'Monzo'` byte-for-byte (5 bytes — fully
 *     clean; 0 of 65 padded). Case-symmetric with the lowercase
 *     5-byte slug `monzo`. **Forty-eighth cohort plugin to omit
 *     D-09**.
 *
 *   - **D-10 — wire-title `.trim()` applied (trailing-pad form).**
 *     6 of 65 wire titles in the run-309 probe carry trailing
 *     ASCII-space padding (~9.2 % pad rate — close to Adyen's
 *     ~10 %, Faire's ~9.7 %). **Twenty-fifth cohort plugin to
 *     apply D-10**.
 *
 *   - **D-11 — fully-clean department pass-through.** 0 of 65
 *     wire department names padded (`'Engineering'`, `'Data'`,
 *     `'Design'`, `'Finance'`, `'Legal'`, `'Marketing &
 *     Community'`, `'Information Security'`, `'Borrowing'`,
 *     `'Company Operations'`, `'Customer Operations'` — clean
 *     multi-token forms with internal whitespace and ampersands).
 *     **Forty-first cohort plugin** with fully-clean department
 *     pass-through.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/monzo/jobs';

@SourcePlugin({
  site: Site.MONZO,
  name: 'Monzo',
  category: 'company',
})
@Injectable()
export class MonzoService implements IScraper {
  private readonly logger = new Logger(MonzoService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Monzo: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10 applied (trailing-pad form): 6/65 wire titles
        // padded (~9.2 %).
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
        const id = `monzo-${jobId}`;

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
            site: Site.MONZO,
            title,
            // D-09 omitted: case-symmetric bare-brand wire.
            companyName: listing.company_name ?? 'Monzo',
            // D-04: wire `absolute_url` flows through (variant 2
            // — canonical Greenhouse host); fallback uses the
            // same canonical variant-2 form.
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/monzo/jobs/${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            // D-11 omitted: 0/65 wire departments padded.
            department: listing.departments?.[0]?.name ?? null,
          }),
        );
      }

      this.logger.log(`Monzo: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Monzo scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
