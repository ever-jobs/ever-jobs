import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * AssemblyAI, Inc. — operator of the **dominant developer-API
 * speech-to-text + speech-AI platform pioneered around the
 * Universal-2 / Universal Streaming low-latency transcription
 * data model** (founded by Dylan Fox in 2017 in San Francisco;
 * raised ~$165M across rounds at peak ~$700M valuation in
 * October 2024 led by Insight Partners; ships speech-to-text
 * (Universal-2 / Universal Streaming), audio intelligence
 * (sentiment, entity, summarization), and the Lemur LLM-on-
 * audio framework across the speech-AI / developer-API segment
 * — alongside competitors Deepgram, OpenAI Whisper API, Google
 * Speech-to-Text, AWS Transcribe, and Rev.ai — with a remote-
 * first distributed workforce concentrated across San Francisco
 * (HQ), New York, and Remote across the United States) —
 * publishes its consolidated careers board through Greenhouse
 * at the bare slug `assemblyai` (the lowercase concatenated
 * brand-name; case-asymmetric with the wire `company_name ===
 * 'AssemblyAI'` THREE-cap PascalCase concat — same byte-count
 * (10 bytes) but byte-distinct via case at THREE indices —
 * see Spec 108 § 10 D-05).
 *
 * **One structural deviation from the StockX (Spec 103)
 * template** — D-10 application (AssemblyAI 1/7 trailing-pad
 * applied; StockX 0/25 omitted).
 *
 *   1. **D-10 — wire-title `.trim()` applied (trailing-pad form).**
 *      1 of 7 wire titles in the run-318 probe carries trailing
 *      ASCII-space padding (~14 % pad rate). Distinct from
 *      StockX's omission. **Thirty-second cohort plugin to
 *      apply D-10**.
 *
 * Shared with StockX:
 *
 *   - **D-04 — wire-shape variant 2 (canonical Greenhouse
 *     host).** `https://job-boards.greenhouse.io/assemblyai/jobs/<id>`.
 *     **Thirty-third** plugin in the cohort to use variant 2.
 *
 *   - **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     **Sixty-fourth** plugin to apply D-08.
 *
 *   - **D-09 — brand-name trim omitted with FIRST-COHORT
 *     PascalCase THREE-CAP same-byte-count case-asymmetric wire
 *     form.** Wire `company_name === 'AssemblyAI'` byte-for-byte
 *     (10 bytes — fully clean; 0 of 7 padded). Slug `assemblyai`
 *     is 10 bytes lowercase; case-asymmetric at THREE byte
 *     indices — `'A'` vs `'a'` at index 0, `'A'` vs `'a'` at
 *     index 8, AND `'I'` vs `'i'` at index 9. **First cohort
 *     observation of THREE-cap PascalCase same-byte-count case-
 *     asymmetry** — distinct from prior TWO-cap forms in SoFi
 *     (Spec 102, caps at 0/2), StockX (Spec 103, caps at 0/5),
 *     and xAI (Spec 105, caps at 1/2). AssemblyAI's three caps
 *     mark the {first-letter-of-Assembly} + {all-letters-of-
 *     AI} two-token camelcase concat with the second token
 *     all-uppercase — first cohort observation of an `<Brand>+AI`
 *     concat where the trailing `AI` initialism is fully-
 *     capitalized. **Fifty-fifth cohort plugin to omit D-09**.
 *
 *   - **D-11 — wire-department `.trim()` applied (trailing-pad
 *     form).** 3 of 7 listings carry `departments[0].name`
 *     records padded with single-trailing-ASCII-space form
 *     (`'Customer Experience '`, `'Product Marketing '`,
 *     `'Research '` — 3 of 5 unique department names padded;
 *     ~43 % listing-level pad rate, the **second-highest D-11
 *     pad-rate observed** in the cohort after BILL's run-302
 *     ~39.1 % — actually higher than BILL — so AssemblyAI is
 *     the **highest D-11 pad-rate observed** in the cohort to
 *     date). **Eighth cohort plugin to apply D-11** (after
 *     Lattice / DataCamp / Typeform / BILL / Dollar Shave Club
 *     / HelloFresh / StockX). **First cohort variant-2 plugin
 *     to apply BOTH D-10 and D-11 simultaneously** (HelloFresh
 *     and BILL both apply both axes but on variants 26 and 24
 *     respectively).
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/assemblyai/jobs';

@SourcePlugin({
  site: Site.ASSEMBLYAI,
  name: 'AssemblyAI',
  category: 'company',
})
@Injectable()
export class AssemblyAIService implements IScraper {
  private readonly logger = new Logger(AssemblyAIService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`AssemblyAI: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10 applied (trailing-pad form): 1/7 wire titles
        // padded (~14 %).
        const title = (listing.title ?? '').trim();
        if (!title) continue;

        // D-11 applied (trailing-pad form): 3/7 listings carry
        // padded department names. Trim BEFORE the searchTerm
        // guard so case-insensitive department matches honour
        // the trimmed form.
        const department = (listing.departments?.[0]?.name ?? '').trim() || null;

        if (input.searchTerm) {
          const term = input.searchTerm.toLowerCase();
          const titleMatch = title.toLowerCase().includes(term);
          const deptMatch = (department ?? '').toLowerCase().includes(term);
          if (!titleMatch && !deptMatch) continue;
        }

        const jobId = listing.id ?? '';
        const id = `assemblyai-${jobId}`;

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
            site: Site.ASSEMBLYAI,
            title,
            // D-09 omitted: PascalCase THREE-cap case-asymmetric
            // wire form (caps at byte indices 0, 8, 9).
            companyName: listing.company_name ?? 'AssemblyAI',
            // D-04: wire `absolute_url` flows through (variant 2
            // — canonical Greenhouse host); fallback uses the
            // same canonical variant-2 form.
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/assemblyai/jobs/${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            // D-11 applied: trimmed wire department.
            department,
          }),
        );
      }

      this.logger.log(`AssemblyAI: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`AssemblyAI scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
