import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Maven Learning, Inc. (Maven.com) — operator of the
 * **dominant cohort-based-online-learning platform pioneered
 * around the live-instructor-led-cohort data model** (founded
 * by Gagan Biyani, Wes Kao, and Shreyans Bhansali in 2020 in
 * San Francisco out of the Y Combinator W21 batch; raised
 * ~$25M Series A in October 2021 led by Andreessen Horowitz;
 * ships Maven Courses (the cohort-based course marketplace),
 * Maven Lightning Lessons (single-session expert events),
 * Maven for Teams (B2B cohort-learning subscriptions), and
 * the Maven Operator platform (course-creation /
 * cohort-orchestration / community-management tooling for
 * independent instructors) across the cohort-based-online-
 * learning / live-cohort-education segment — alongside
 * competitors Coursera (cohorts), Udemy Live, Section,
 * Reforge, and the corporate-LMS lineage of Lightcast
 * Learning, Cornerstone, and Degreed — with a hybrid
 * distributed workforce concentrated across San Francisco
 * (HQ), New York City, and Remote across the United States)
 * — publishes its consolidated careers board through
 * Greenhouse at the bare slug `maven` (case-symmetric with
 * the wire `company_name === 'Maven'`; see Spec 162 § 10
 * D-05).
 *
 * Not to be confused with the existing Maven Clinic plugin
 * (Spec 076 / `mavenclinic` slug) — Maven Learning publishes
 * a distinct `maven` Greenhouse board.
 *
 * **Zero structural deviations from the Markforged (Spec
 * 161) template** — case-symmetric brand wire, variant 2
 * URL, D-08 entity-decode-then-tag-strip, D-10 omitted, D-11
 * omitted. **Forty-fifth clean re-spin** in run-history.
 *
 *   1. **D-04 — wire-shape variant 2 (canonical Greenhouse host).**
 *     `https://job-boards.greenhouse.io/maven/jobs/<id>`.
 *     **Sixty-seventh** plugin in the cohort to use variant 2.
 *
 *   2. **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     **One-hundred-and-eighteenth** plugin to apply D-08.
 *
 *   3. **D-09 — brand-name trim omitted (case-symmetric).** Wire
 *     `company_name === 'Maven'` byte-for-byte (5 bytes —
 *     fully clean, case-symmetric with the lowercase 5-byte
 *     slug `maven`). **One-hundred-and-ninth cohort plugin to
 *     omit D-09**.
 *
 *   4. **D-10 — wire-title `.trim()` omitted (clean wire).**
 *     0 of 5 wire titles padded; the plugin applies `.trim()`
 *     defensively as a safe no-op. **Thirty-fifth cohort
 *     plugin to omit D-10**.
 *
 *   5. **D-11 — wire-department `.trim()` omitted (clean wire).**
 *     0 of 4 unique wire department names padded
 *     (`'Engineering'`, `'Growth'`, `'Operations'`,
 *     `'Product'`); the plugin applies `.trim()` defensively
 *     as a safe no-op. **Ninety-fourth cohort plugin** with
 *     fully-clean department pass-through.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/maven/jobs';

@SourcePlugin({
  site: Site.MAVEN,
  name: 'Maven',
  category: 'company',
})
@Injectable()
export class MavenService implements IScraper {
  private readonly logger = new Logger(MavenService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Maven: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10 omitted at probe time; .trim() is a safe no-op
        // on clean wire.
        const title = (listing.title ?? '').trim();
        if (!title) continue;

        // D-11 omitted at probe time; .trim() is a safe no-op
        // on clean wire.
        const dept = (listing.departments?.[0]?.name ?? '').trim() || null;

        if (input.searchTerm) {
          const term = input.searchTerm.toLowerCase();
          const titleMatch = title.toLowerCase().includes(term);
          const deptMatch = (dept ?? '').toLowerCase().includes(term);
          if (!titleMatch && !deptMatch) continue;
        }

        const jobId = listing.id ?? '';
        const id = `maven-${jobId}`;

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
            site: Site.MAVEN,
            title,
            // D-09 omitted: case-symmetric bare-brand wire.
            companyName: listing.company_name ?? 'Maven',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/maven/jobs/${listing.id}`,
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

      this.logger.log(`Maven: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Maven scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
