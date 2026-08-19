import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Attentive Mobile Inc. — AI-native conversational-commerce / SMS &
 * email-marketing platform vendor — publishes its consolidated careers
 * board through Greenhouse at the bare `attentive` slug (no asymmetry;
 * see Spec 058 § 10 D-05).
 *
 * One structural deviation from the Webflow (Spec 056) template:
 *
 *   1. **D-10 — wire-title `.trim()`.** A subset of Attentive wire
 *      titles carry trailing ASCII-space padding (4 of 59 titles in
 *      the run-268 probe — e.g. `'Director of Engineering, Intelligent
 *      Messaging '`, `'Principal Technical Program Manager '`,
 *      `'Staff Software Engineer, Streaming '`, `'Support Engineer
 *      (West) '`). The plugin applies `.trim()` to the wire `title`
 *      before the empty-title skip check AND before the `searchTerm`
 *      filter AND before the `JobPostDto` emit, so the emitted `title`
 *      is the trimmed form. Fourth plugin in the cohort to apply a
 *      wire-title trim (after Brex `Spec 047 § 10 D-10`, Buildkite
 *      `Spec 050 § 10 D-10`, and ZoomInfo `Spec 057 § 10 D-10`).
 *
 * Description-cleanup pipeline `stripHtmlTags(decodeHtmlEntities(content))`
 * is identical to Webflow's because Attentive's `content` is also HTML-
 * entity-encoded (`&lt;div class=&quot;content-intro&quot;&gt;...`) —
 * confirmed via run #268's HTTP probe of the live API where the first
 * job's `content` starts with `&lt;div class=&quot;content-intro&quot;
 * &gt;&lt;div&gt;Attentive® is the AI marketing platform for 1:1
 * personalization redefining the way brands and people connect.` (Spec
 * 058 § 10 D-08). The wire payload also includes the named entity
 * `&rsquo;` (decodes to `'` U+2019) and the numeric entity `&#39;`
 * (decodes to apostrophe). This is the **fourteenth** company-direct
 * plugin in the cohort to use the entity-decode-then-tag-strip
 * description pipeline.
 *
 * Fallback `jobUrl` shape (`job-boards.greenhouse.io/attentive/jobs/<id>`)
 * matches the wire `absolute_url` byte-for-byte — same as Vercel /
 * Affirm / Gusto / Mercury / Buildkite / Netlify / Postman / Webflow
 * (Spec 058 § 10 D-04). This is the ninth plugin in the cohort to use
 * variant 2 (the US-region permalink subdomain).
 *
 * Brand-name pin (`'Attentive'`) matches the wire `company_name`
 * byte-for-byte — same as Postman / Netlify / Mercury / Buildkite /
 * CircleCI / Ramp Network / Toast / Webflow (Spec 058 § 10 D-09).
 *
 * Department pass-through preserves Attentive's flat single-token
 * department names (`'Finance'`, `'Engineering'`, `'Sales'`, `'Customer
 * Success'`, `'Office of CSO'`, etc.) byte-for-byte (Spec 058 § 10
 * D-11) — distinct from ZoomInfo's numeric-code-prefix format and
 * Toast's colon-separated nested-path format.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/attentive/jobs';

@SourcePlugin({
  site: Site.ATTENTIVE,
  name: 'Attentive',
  category: 'company',
})
@Injectable()
export class AttentiveService implements IScraper {
  private readonly logger = new Logger(AttentiveService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Attentive: fetching ${url}`);

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
        const id = `attentive-${jobId}`;

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
            site: Site.ATTENTIVE,
            title,
            companyName: 'Attentive',
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/attentive/jobs/${listing.id}`,
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

      this.logger.log(`Attentive: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Attentive scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
