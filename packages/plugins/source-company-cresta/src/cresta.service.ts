import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Cresta Inc. (cresta.com) — operator of the **dominant
 * AI-contact-center platform pioneered around the
 * conversational-intelligence-coaching data model**
 * (founded by Zayd Enam, Tim Shi, and Sebastian Thrun in
 * 2017 in San Francisco out of the Stanford AI Lab; raised
 * ~$80M Series E at a ~$1.6B valuation in February 2024
 * led by Tiger Global / Greylock; ships Cresta Agent
 * Assist (real-time agent-side coaching), Cresta Director
 * (supervisor-side workflow), Cresta Insights (post-call
 * analytics + conversation-mining), and Cresta Virtual
 * Agent (LLM-powered self-service) across the AI
 * contact-center / conversational-intelligence-coaching
 * segment — alongside competitors Observe.AI, Gong,
 * Salesforce Einstein for Service, and NICE Enlighten —
 * with a hybrid workforce concentrated across San
 * Francisco, Toronto, London, and Remote across the
 * Americas / EMEA / APAC) — publishes its consolidated
 * careers board through Greenhouse at the bare slug
 * `cresta` (case-symmetric with the wire
 * `company_name === 'Cresta'`; see Spec 165 § 10 D-05).
 *
 * **One D-10 sub-axis observation off Postscript (Spec 164)**
 * — case-symmetric brand wire, variant 2 URL, D-08
 * entity-decode-then-tag-strip, D-10 trailing-pad-dominant
 * applied with one leading-only-pad observation, D-11
 * omitted. **Forty-seventh near-clean re-spin** in
 * run-history.
 *
 *   1. **D-04 — wire-shape variant 2 (canonical Greenhouse host).**
 *     `https://job-boards.greenhouse.io/cresta/jobs/<id>`.
 *     **Sixty-ninth** plugin in the cohort to use variant 2.
 *
 *   2. **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     **One-hundred-and-twenty-first** plugin to apply D-08.
 *
 *   3. **D-09 — brand-name trim omitted (case-symmetric).** Wire
 *     `company_name === 'Cresta'` byte-for-byte (6 bytes
 *     — fully clean, case-symmetric with the lowercase 6-byte
 *     slug `cresta`). **One-hundred-and-twelfth cohort
 *     plugin to omit D-09**.
 *
 *   4. **D-10 — wire-title `.trim()` APPLIED (trailing-pad-
 *     dominant + leading-pad sub-axis form).** 30 of 114
 *     wire titles in the run-375 probe carry trailing
 *     ASCII-space padding (~26.3 % trail-pad rate) and 1 of
 *     114 carries leading-only padding (~0.88 % lead-pad
 *     rate). The plugin applies `.trim()` to the wire
 *     `title` byte-for-byte before downstream emit;
 *     `.trim()` is symmetric and handles both pad forms
 *     identically. **Seventy-fifth cohort plugin to apply
 *     D-10**.
 *
 *   5. **D-11 — wire-department `.trim()` omitted (clean wire).**
 *     0 of 8 unique wire department names padded
 *     (`'Customer Success'`, `'Engineering'`, `'Finance'`,
 *     `'HR'`, `'Marketing'`, `'Product'`, `'Sales'`,
 *     `'Technical Operations'`); the plugin applies
 *     `.trim()` defensively as a safe no-op. **Ninety-
 *     seventh cohort plugin** with fully-clean department
 *     pass-through.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/cresta/jobs';

@SourcePlugin({
  site: Site.CRESTA,
  name: 'Cresta',
  category: 'company',
})
@Injectable()
export class CrestaService implements IScraper {
  private readonly logger = new Logger(CrestaService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Cresta: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10 applied (trailing-pad-dominant + leading-pad sub-axis):
        // 30/114 trail-pad + 1/114 lead-pad; .trim() symmetric.
        const title = (listing.title ?? '').trim();
        if (!title) continue;

        // D-11 omitted at probe time; .trim() is a safe no-op.
        const dept = (listing.departments?.[0]?.name ?? '').trim() || null;

        if (input.searchTerm) {
          const term = input.searchTerm.toLowerCase();
          const titleMatch = title.toLowerCase().includes(term);
          const deptMatch = (dept ?? '').toLowerCase().includes(term);
          if (!titleMatch && !deptMatch) continue;
        }

        const jobId = listing.id ?? '';
        const id = `cresta-${jobId}`;

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
            site: Site.CRESTA,
            title,
            // D-09 omitted: case-symmetric bare-brand wire.
            companyName: listing.company_name ?? 'Cresta',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/cresta/jobs/${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            department: dept,
          }),
        );
      }

      this.logger.log(`Cresta: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Cresta scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
