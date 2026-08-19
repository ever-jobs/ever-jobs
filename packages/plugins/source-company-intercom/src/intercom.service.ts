import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Intercom Inc. — AI-native customer-service / customer-messaging
 * platform vendor (operator of Fin, Inbox, Messenger, Help Center,
 * Outbound, Workflows, and the Customer Data Platform) — publishes its
 * consolidated careers board through Greenhouse at the bare `intercom`
 * slug (no asymmetry; see Spec 061 § 10 D-05).
 *
 * Zero structural deviations from the Attentive (Spec 058) template —
 * Intercom is a near-pure Attentive twin:
 *
 *   - **D-04 — wire-shape variant 2.** Intercom's tenant publishes its
 *     `absolute_url` on the US-region permalink subdomain
 *     `https://job-boards.greenhouse.io/intercom/jobs/<id>` shape — the
 *     tenth plugin in the cohort to use variant 2 (after Vercel, Affirm,
 *     Gusto, Mercury, Buildkite, Netlify, Postman, Webflow, Attentive).
 *     The fallback `jobUrl` constructor mirrors this byte-for-byte.
 *
 *   - **D-08 — entity-decode-then-tag-strip description pipeline.** Like
 *     every plugin from Klaviyo onwards, Intercom's `content` is
 *     HTML-entity-encoded (`&lt;div class=&quot;content-intro&quot;
 *     &gt;&lt;p&gt;Intercom is the AI Customer Service company...`),
 *     so the plugin decodes entities BEFORE stripping tags. Seventeenth
 *     plugin in the cohort to apply D-08.
 *
 *   - **D-09 — brand-name trim omitted.** Wire `company_name === 'Intercom'`
 *     byte-for-byte (no legal-entity suffix); the plugin reads
 *     `listing.company_name` directly without a string-literal pin.
 *
 *   - **D-10 — wire-title `.trim()`.** A subset of Intercom wire titles
 *     carry trailing ASCII-space padding (25 of 174 titles in the
 *     run-271 probe — 14.4 %, the highest pad-rate of any cohort plugin
 *     to date — e.g. `'Account Executive, Commercial '`, `'Account
 *     Executive, Commercial - French Speaking '`, `'Account Executive
 *     (Existing Business), Commercial '`, `'Business Development
 *     Representative, Emerging AI Products '`, `'Director, Sales
 *     Strategy & Planning '`). The plugin applies `.trim()` to the wire
 *     `title` before the empty-title skip check AND before the
 *     `searchTerm` filter AND before the `JobPostDto` emit, so the
 *     emitted `title` is the trimmed form. Sixth plugin in the cohort
 *     to apply a wire-title trim (after Brex `Spec 047 § 10 D-10`,
 *     Buildkite `Spec 050 § 10 D-10`, ZoomInfo `Spec 057 § 10 D-10`,
 *     Attentive `Spec 058 § 10 D-10`, and Elastic `Spec 060 § 10 D-10`).
 *
 *   - **D-11 — flat single-token department name pass-through.**
 *     Intercom's wire `departments[0].name` payload uses flat
 *     single-token department names (`'Sales'`, `'Engineering'`,
 *     `'Product'`, `'Marketing'`, `'Finance & Business Operations'`,
 *     `'Customer Success & Solutions'`, `'AI Group'`, `'R&D'`,
 *     `'Recruiting'`, `'Research, Analytics & Data Science'`,
 *     `'Customer Support'`, `'Legal '`, `'People'`, `'Product Design'`,
 *     `'Revenue Operations'`) — distinct from Elastic's compound
 *     `' - '`-separated regional-scoped format, ZoomInfo's numeric-
 *     code-prefix format, Toast's colon-separated nested-path format,
 *     and Chime's single-token format. Notably, one wire department
 *     name (`'Legal '`) carries trailing ASCII-space padding similar
 *     to the wire-title pad pattern D-10 captures, but the plugin
 *     emits the wire `departments[0].name` byte-for-byte (no
 *     department-name trim — the case-insensitive `searchTerm` filter
 *     remains semantically correct because `'Legal '.toLowerCase()
 *     .includes('legal')` is true).
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/intercom/jobs';

@SourcePlugin({
  site: Site.INTERCOM,
  name: 'Intercom',
  category: 'company',
})
@Injectable()
export class IntercomService implements IScraper {
  private readonly logger = new Logger(IntercomService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Intercom: fetching ${url}`);

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
        const id = `intercom-${jobId}`;

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
            site: Site.INTERCOM,
            title,
            companyName: listing.company_name ?? 'Intercom',
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/intercom/jobs/${listing.id}`,
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

      this.logger.log(`Intercom: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Intercom scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
