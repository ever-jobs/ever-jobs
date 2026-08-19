import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Chime Financial, Inc. — US neobank / challenger-bank / consumer-fintech
 * vendor — publishes its consolidated careers board through Greenhouse
 * at the bare `chime` slug (no asymmetry; see Spec 059 § 10 D-05).
 *
 * Two structural deviations from the Attentive (Spec 058) template:
 *
 *   1. **D-04 — wire-shape variant 10 fallback URL.** Chime's tenant
 *      publishes its `absolute_url` on the **legacy hosted-board** apex
 *      `https://boards.greenhouse.io/chime/jobs/<id>?gh_jid=<id>` — the
 *      bare `boards.greenhouse.io` host without the `job-` prefix, plus
 *      a trailing `?gh_jid=<id>` query suffix. First plugin in the
 *      cohort to use variant 10 (distinct from variant 2's modern
 *      US-region permalink subdomain `job-boards.greenhouse.io/<slug>/
 *      jobs/<id>` used by Vercel, Affirm, Gusto, Mercury, Buildkite,
 *      Netlify, Postman, Webflow, and Attentive).
 *
 *   2. **D-09 — brand-name trim string-literal pin.** Chime's wire
 *      `company_name` carries the legal-entity suffix
 *      `'Chime Financial, Inc'` (note: no trailing `.` after `Inc`,
 *      unlike Affirm's `'Affirm, Inc.'` form). The plugin pins
 *      `companyName === 'Chime'` as a string literal in the JobPostDto
 *      mapping rather than reading `listing.company_name` directly.
 *      Fourth plugin in the cohort to apply a brand-name trim D-09
 *      (after Affirm `Spec 044 § 10 D-09`, Gusto `Spec 048 § 10 D-09`,
 *      and ZoomInfo `Spec 057 § 10 D-09`); the **second** to clean a
 *      comma-separated suffix (after Affirm) and the **first** to clean
 *      a comma-separated suffix where the legal-entity token (`'Inc'`)
 *      carries no trailing period.
 *
 * Description-cleanup pipeline `stripHtmlTags(decodeHtmlEntities(content))`
 * is identical to Attentive's because Chime's `content` is also HTML-
 * entity-encoded (`&lt;h2&gt;&lt;span style=&quot;font-family:
 * helvetica, arial, sans-serif;&quot;&gt;&lt;strong&gt;About the
 * role&lt;/strong&gt;...`) — confirmed via run #269's HTTP probe of
 * the live API where 72 of 72 wire jobs carry HTML entities and 0 of
 * 72 carry raw HTML tags (Spec 059 § 10 D-08). This is the **fifteenth**
 * company-direct plugin in the cohort to use the
 * entity-decode-then-tag-strip description pipeline.
 *
 * Department pass-through preserves Chime's flat single-token
 * department names (`'Accounting'`, `'Engineering'`, `'Finance'`,
 * `'Enterprise S&M'` — including the literal `&` byte in `'Enterprise
 * S&M'` which flows through the wire as a literal `&` byte rather than
 * the entity-encoded `&amp;`) byte-for-byte (Spec 059 § 10 D-11).
 *
 * Wire `title` is **not** trimmed (D-10 omitted) — all 72 wire titles
 * in the run-269 probe were already trim-clean. First cohort plugin
 * since Webflow (Spec 056) to omit D-10.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/chime/jobs';

@SourcePlugin({
  site: Site.CHIME,
  name: 'Chime',
  category: 'company',
})
@Injectable()
export class ChimeService implements IScraper {
  private readonly logger = new Logger(ChimeService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Chime: fetching ${url}`);

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
        const id = `chime-${jobId}`;

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
            site: Site.CHIME,
            title,
            // D-09: pin the brand name `'Chime'` as a string literal
            // rather than passing through the wire `'Chime Financial,
            // Inc'`.
            companyName: 'Chime',
            // D-04: variant-10 legacy hosted-board fallback —
            // `boards.greenhouse.io/<slug>/jobs/<id>?gh_jid=<id>`.
            jobUrl:
              listing.absolute_url ??
              `https://boards.greenhouse.io/chime/jobs/${listing.id}?gh_jid=${listing.id}`,
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

      this.logger.log(`Chime: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Chime scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
