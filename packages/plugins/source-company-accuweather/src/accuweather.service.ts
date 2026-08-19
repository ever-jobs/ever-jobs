import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * AccuWeather, Inc. — operator of the **dominant private-
 * sector global weather-forecasting and severe-weather-
 * warning service** providing minute-by-minute hyperlocal
 * forecasts, AccuWeather MinuteCast®, RealFeel® proprietary
 * apparent-temperature index, and global storm-warning
 * telemetry (founded by Joel N. Myers in 1962 in State
 * College, Pennsylvania; privately held; serves over half
 * of the Fortune 500 companies plus thousands of business
 * and government clients across enterprise weather solutions,
 * broadcast media partnerships, digital ad inventory, and
 * consumer mobile / web properties; ships AccuWeather for
 * Business (enterprise-tier custom forecasts + severe-
 * weather alerts), AccuWeather Network (24/7 weather
 * television channel), AccuWeather.com (consumer web +
 * mobile), and AccuWeather MinuteCast® / RealFeel®
 * proprietary forecast products across the global private-
 * sector weather-services segment — alongside competitors
 * The Weather Company / IBM Weather, Tomorrow.io, DTN,
 * Météo-France, Met Office, and StormGeo — with a hybrid
 * distributed workforce concentrated across State College,
 * PA (HQ), Wichita, KS (broadcast), Birmingham, AL (radar /
 * forecast operations), New York, NY (sales / media), and
 * Remote across the United States) — publishes its
 * consolidated careers board through Greenhouse at the bare
 * slug `accuweather` (wire `company_name === 'AccuWeather
 * Careers'` — see Spec 175 § 10 D-09).
 *
 * **Two structural deviations from the Tatari (Spec 173)
 * template** —
 *
 *   - **D-09 sub-axis:** case-symmetric bare-brand
 *     `'Tatari'` → **simultaneous TWO-cap PascalCase + slug-
 *     truncation** `'AccuWeather Careers'`. **First cohort
 *     observation of TWO-cap PascalCase + slug-truncation
 *     co-occurring in the same wire `company_name`.**
 *   - **D-11 sub-axis:** clean pass-through → **trailing-pad
 *     applied** (2 of 15 unique departments padded —
 *     `'Facilities '`, `'Information Systems '`).
 *
 *   1. **D-04 — wire-shape variant 2 (canonical Greenhouse host).**
 *     `https://job-boards.greenhouse.io/accuweather/jobs/<id>`.
 *     **Seventy-fifth** plugin in the cohort to use variant 2.
 *
 *   2. **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     **One-hundred-and-thirty-first** plugin to apply D-08.
 *
 *   3. **D-09 — brand-name omitted at runtime; wire form
 *     pass-through.** Wire `company_name === 'AccuWeather
 *     Careers'` byte-for-byte (19 bytes). First wire token
 *     `AccuWeather` 11 bytes carries TWO-cap PascalCase
 *     case-asymmetry at byte indices 0 (`A` vs `a`) and 4
 *     (`W` vs `w`) vs lowercase 11-byte slug `accuweather`;
 *     wire drops 1 trailing token `Careers`. **9th cohort
 *     plugin with TWO-cap PascalCase D-09 sub-axis** and
 *     **6th cohort observation of slug-truncation D-09 sub-
 *     axis** (new shortest non-zero token-truncation factor:
 *     1 token dropped). **First cohort observation of TWO-
 *     cap PascalCase + slug-truncation co-occurring in the
 *     same wire `company_name`.**
 *
 *   4. **D-10 — wire-title `.trim()` applied (trailing-pad form).**
 *     7 of 30 wire titles in the run-385 probe carry
 *     trailing ASCII-space padding (~23.3 % pad rate — new
 *     cohort-wide high-watermark since SimpliSafe ~14.3 %).
 *     **Eightieth cohort plugin to apply D-10**.
 *
 *   5. **D-11 — wire-department `.trim()` applied (trailing-
 *     pad form).** 2 of 15 unique wire department names
 *     padded (`'Facilities '`, `'Information Systems '`).
 *     **Twenty-first cohort plugin to apply D-11**.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/accuweather/jobs';

@SourcePlugin({
  site: Site.ACCUWEATHER,
  name: 'AccuWeather',
  category: 'company',
})
@Injectable()
export class AccuWeatherService implements IScraper {
  private readonly logger = new Logger(AccuWeatherService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`AccuWeather: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10 applied (trailing-pad form): 7/30 wire titles
        // padded (~23.3 %) — cohort-wide high-watermark since
        // SimpliSafe (~14.3 %).
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
        const id = `accuweather-${jobId}`;

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
            site: Site.ACCUWEATHER,
            title,
            // D-09 pass-through: wire `'AccuWeather Careers'`
            // (TWO-cap PascalCase + slug-truncation co-form).
            companyName: listing.company_name ?? 'AccuWeather Careers',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/accuweather/jobs/${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            // D-11 applied (trailing-pad form): 2/15 unique
            // departments padded — `'Facilities '`,
            // `'Information Systems '`.
            department: listing.departments?.[0]?.name
              ? listing.departments[0].name.trim()
              : null,
          }),
        );
      }

      this.logger.log(`AccuWeather: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`AccuWeather scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
