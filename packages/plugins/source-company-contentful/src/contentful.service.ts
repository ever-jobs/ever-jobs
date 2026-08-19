import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Contentful GmbH (Contentful AG) — operator of the **dominant
 * API-first headless-CMS / composable-content platform
 * pioneered around the structured-content-as-a-service data
 * model** (founded by Sascha Konietzke, Paolo Negri, and
 * Rouven Westphal in 2013 in Berlin, Germany; raised ~$330M
 * across rounds at peak ~$3B valuation in July 2021 led by
 * Tiger Global Management; ships Contentful Composable
 * Content Platform (headless CMS), Contentful Studio (visual
 * editor), Contentful Apps Framework, Contentful Live Preview,
 * and Compose + Launch app integrations across the headless-
 * CMS / composable-content / digital-experience-platform
 * segment — alongside competitors Sanity, Strapi, Storyblok,
 * Adobe Experience Manager, Sitecore, and Hygraph (formerly
 * GraphCMS) — with a hybrid distributed workforce concentrated
 * across Berlin (HQ), Denver, San Francisco, London, Aveiro
 * (Portugal), and Remote across the United States, Germany,
 * the United Kingdom, Portugal, the European Union, and
 * Canada) — publishes its consolidated careers board through
 * Greenhouse at the bare slug `contentful` (case-symmetric
 * with the wire `company_name === 'Contentful'`; see Spec 124
 * § 10 D-05).
 *
 * **Zero structural deviations from the Checkr (Spec 123)
 * template** — making this the **twenty-seventh** Greenhouse-
 * only company-direct plugin in run-history to ship as a
 * clean re-spin. All five primary axes share with Checkr:
 *
 *   - **D-04 — wire-shape variant 2 (canonical Greenhouse host).**
 *     `https://job-boards.greenhouse.io/contentful/jobs/<id>`.
 *     **Forty-third** plugin in the cohort to use variant 2.
 *
 *   - **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     **Eightieth** plugin to apply D-08 — the cohort crosses
 *     the 80-plugin D-08-application threshold at this run.
 *
 *   - **D-09 — brand-name trim omitted (case-symmetric).** Wire
 *     `company_name === 'Contentful'` byte-for-byte (10 bytes
 *     — fully clean, case-symmetric with the lowercase 10-byte
 *     slug `contentful`). **Seventy-first cohort plugin to
 *     omit D-09**.
 *
 *   - **D-10 — wire-title `.trim()` applied (trailing-pad form).**
 *     8 of 108 wire titles in the run-334 probe carry trailing
 *     ASCII-space padding (~7.4 % pad rate; e.g. `'Manager,
 *     Security Engineering '`, `'Manager, Security Engineering
 *     (Corporate Systems) '`). All trailing-only. **Forty-
 *     sixth cohort plugin to apply D-10**.
 *
 *   - **D-11 — fully-clean department pass-through.** 0 of 108
 *     wire department names padded across 9 unique departments
 *     (`'Customer Experience'`, `'Engineering'`, `'Finance'`,
 *     `'IT'`, `'Marketing'`, `'Partnerships'`, `'Product'`,
 *     `'Sales'`, `'Security'` — clean multi-token forms with
 *     internal whitespace). **Sixty-fourth cohort plugin**
 *     with fully-clean department pass-through.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/contentful/jobs';

@SourcePlugin({
  site: Site.CONTENTFUL,
  name: 'Contentful',
  category: 'company',
})
@Injectable()
export class ContentfulService implements IScraper {
  private readonly logger = new Logger(ContentfulService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Contentful: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10 applied (trailing-pad form): 8/108 wire titles
        // padded (~7.4 %).
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
        const id = `contentful-${jobId}`;

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
            site: Site.CONTENTFUL,
            title,
            // D-09 omitted: case-symmetric bare-brand wire.
            companyName: listing.company_name ?? 'Contentful',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/contentful/jobs/${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            // D-11 omitted: 0/108 wire departments padded.
            department: listing.departments?.[0]?.name ?? null,
          }),
        );
      }

      this.logger.log(`Contentful: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Contentful scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
