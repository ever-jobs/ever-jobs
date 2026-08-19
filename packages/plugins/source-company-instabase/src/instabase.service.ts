import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Instabase, Inc. (Instabase.com) — operator of the
 * **dominant deep-document-understanding AI platform pioneered
 * around the unstructured-document-to-structured-data data
 * model** (founded by Anant Bhardwaj in 2015 in San Francisco
 * out of MIT CSAIL research; raised ~$390M across rounds at
 * peak ~$2B valuation in October 2023 led by Tribe Capital and
 * Andreessen Horowitz; ships Instabase AI Hub (the
 * conversational-document-AI front-end), Instabase Automation
 * (document-extraction pipelines), Instabase Build (low-code
 * application authoring over document data), and Instabase
 * Apps (vertical-tuned packages for financial services,
 * insurance, and the public sector) across the document-AI /
 * intelligent-document-processing segment — alongside
 * competitors Hyperscience, ABBYY, UiPath Document
 * Understanding, AWS Textract, Google Document AI, Azure Form
 * Recognizer, Rossum, and Klippa — with a hybrid distributed
 * workforce concentrated across San Francisco (HQ), New York
 * City, London, Bengaluru, and Remote across the United
 * States, the United Kingdom, and India) — publishes its
 * consolidated careers board through Greenhouse at the bare
 * slug `instabase` (case-symmetric with the wire
 * `company_name === 'Instabase'`; see Spec 158 § 10 D-05).
 *
 * **Zero structural deviations from the Melio (Spec 130)
 * template** — case-symmetric brand wire, variant 2 URL,
 * D-08 entity-decode-then-tag-strip, D-10 applied (mixed
 * leading + trailing pad form — 7th cohort observation of
 * leading-pad sub-axis after Chainguard / Oscar / Celonis /
 * Formlabs / GoFundMe / BitGo), D-11 applied (trailing-pad
 * form). **Forty-second clean re-spin** in run-history.
 *
 *   1. **D-04 — wire-shape variant 2 (canonical Greenhouse host).**
 *     `https://job-boards.greenhouse.io/instabase/jobs/<id>`.
 *
 *   2. **D-08 — entity-decode-then-tag-strip description pipeline.**
 *
 *   3. **D-09 — brand-name trim omitted (case-symmetric).** Wire
 *     `company_name === 'Instabase'` byte-for-byte (9 bytes —
 *     fully clean, case-symmetric with the lowercase 9-byte
 *     slug `instabase`).
 *
 *   4. **D-10 — wire-title `.trim()` APPLIED (mixed-pad form,
 *      7th cohort leading-pad observation).** 2 of 12 wire
 *      titles in the run-368 probe carry whitespace padding —
 *      one trailing, one leading. The plugin applies `.trim()`
 *      to the wire `title` byte-for-byte before downstream
 *      emit.
 *
 *   5. **D-11 — wire-department `.trim()` APPLIED (trailing-
 *      pad form).** 2 of 8 unique wire department names
 *      padded (`'Finance/Accounting '`, `'Recruiting '`); the
 *      plugin applies `.trim()` to the wire
 *      `departments[0].name` byte-for-byte before downstream
 *      emit. Note: `'Finance/Accounting '` contains a `/`
 *      separator — downstream rendering / parsing semantics
 *      out-of-scope for this plugin.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/instabase/jobs';

@SourcePlugin({
  site: Site.INSTABASE,
  name: 'Instabase',
  category: 'company',
})
@Injectable()
export class InstabaseService implements IScraper {
  private readonly logger = new Logger(InstabaseService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`Instabase: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10 applied (mixed-pad form): 2/12 wire titles
        // padded — leading + trailing samples.
        const title = (listing.title ?? '').trim();
        if (!title) continue;

        // D-11 applied (trailing-pad form): trim wire dept
        // name to handle 'Finance/Accounting ' and 'Recruiting '.
        const dept = (listing.departments?.[0]?.name ?? '').trim() || null;

        if (input.searchTerm) {
          const term = input.searchTerm.toLowerCase();
          const titleMatch = title.toLowerCase().includes(term);
          const deptMatch = (dept ?? '').toLowerCase().includes(term);
          if (!titleMatch && !deptMatch) continue;
        }

        const jobId = listing.id ?? '';
        const id = `instabase-${jobId}`;

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
            site: Site.INSTABASE,
            title,
            // D-09 omitted: case-symmetric bare-brand wire.
            companyName: listing.company_name ?? 'Instabase',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/instabase/jobs/${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            // D-11 applied: trim handles 'Finance/Accounting ' and 'Recruiting '.
            department: dept,
          }),
        );
      }

      this.logger.log(`Instabase: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`Instabase scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
