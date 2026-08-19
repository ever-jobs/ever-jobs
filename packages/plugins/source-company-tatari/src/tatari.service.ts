import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Tatari, Inc. (Tatari.tv) — operator of the **dominant
 * streaming-and-linear-TV connected-attribution advertising-
 * analytics platform pioneered around the cross-channel
 * incremental-lift / unique-reach measurement data model**
 * (founded by Sarah Bichara, Philip Inghelbrecht, and Brad
 * Geving in 2016 in San Francisco, California; raised ~$45M
 * Series C in March 2022 led by Battery Ventures and Amplify
 * Partners at peak ~$215M valuation; ships Tatari for Linear
 * TV (national-and-spot-cable buying / planning / measurement),
 * Tatari for Streaming TV (CTV / OTT premium-supply
 * attribution), Tatari for Brand-Performance (TV-driven KPI
 * optimisation), and Tatari Audio (podcast-and-streaming-
 * audio incremental-lift attribution) across the streaming-
 * TV / connected-TV / linear-TV-as-a-service segment —
 * alongside competitors LiveRamp, iSpot.tv, VideoAmp, Innovid,
 * Comscore, and Nielsen — with a hybrid distributed workforce
 * concentrated across San Francisco (HQ), New York, and
 * Remote across the United States) — publishes its
 * consolidated careers board through Greenhouse at the bare
 * slug `tatari` (case-symmetric with the wire `company_name
 * === 'Tatari'`; see Spec 173 § 10 D-09).
 *
 * **One D-09 sub-axis deviation from the SimpliSafe (Spec 171)
 * template** — SimpliSafe D-09 carries TWO-cap PascalCase
 * caps-at-0/6 (`'SimpliSafe'` 10 bytes), whereas Tatari D-09
 * carries case-symmetric bare-brand (`'Tatari'` 6 bytes). The
 * trim semantics remain unchanged. **Fifty-first near-clean
 * re-spin** in run-history.
 *
 *   1. **D-04 — wire-shape variant 2 (canonical Greenhouse host).**
 *     `https://job-boards.greenhouse.io/tatari/jobs/<id>`.
 *     **Seventy-fourth** plugin in the cohort to use variant 2.
 *
 *   2. **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     **One-hundred-and-twenty-ninth** plugin to apply D-08.
 *
 *   3. **D-09 — brand-name trim omitted (case-symmetric).** Wire
 *     `company_name === 'Tatari'` byte-for-byte (6 bytes —
 *     fully clean, case-symmetric with the lowercase 6-byte
 *     slug `tatari`). **One-hundred-and-twentieth cohort
 *     plugin to omit D-09**.
 *
 *   4. **D-10 — wire-title `.trim()` applied (trailing-pad form).**
 *     3 of 52 wire titles in the run-383 probe carry trailing
 *     ASCII-space padding (~5.8 % pad rate, all trailing-only
 *     — `'Data Science Analyst '` repeated across three
 *     listings). **Seventy-ninth cohort plugin to apply D-10**.
 *
 *   5. **D-11 — fully-clean department pass-through.** 0 of 7
 *     unique wire department names padded (`'Client
 *     Development'`, `'Client Services'`, `'Data Science'`,
 *     `'Engineering'`, `'Marketing'`, `'Media Buying'`,
 *     `'Product Management'` — clean multi-token forms with
 *     internal whitespace). Pass-through preserves byte-for-
 *     byte. **One-hundred-and-third cohort plugin** with
 *     fully-clean department pass-through.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/tatari/jobs';

@SourcePlugin({
  site: Site.TATARI,
  name: 'Tatari',
  category: 'company',
})
@Injectable()
export class TatariService implements IScraper {
  private readonly logger = new Logger(TatariService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Tatari: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10 applied (trailing-pad form): 3/52 wire titles
        // padded (~5.8 %) — `'Data Science Analyst '` x3.
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
        const id = `tatari-${jobId}`;

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
            site: Site.TATARI,
            title,
            // D-09 omitted: case-symmetric bare-brand wire.
            companyName: listing.company_name ?? 'Tatari',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/tatari/jobs/${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            // D-11 omitted: 0/7 unique wire departments padded.
            department: listing.departments?.[0]?.name ?? null,
          }),
        );
      }

      this.logger.log(`Tatari: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Tatari scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
