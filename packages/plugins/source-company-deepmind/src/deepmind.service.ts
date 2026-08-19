import { SourcePlugin } from '@ever-jobs/plugin';

import { Injectable, Logger } from '@nestjs/common';
import {
  classifyScrapeError,
  IScraper, ScraperInputDto, JobResponseDto, JobPostDto, Site, LocationDto,
} from '@ever-jobs/models';
import { createHttpClient, decodeHtmlEntities, stripHtmlTags } from '@ever-jobs/common';

/**
 * Google DeepMind — operator of the **leading frontier-AI
 * research lab pioneered around the deep-reinforcement-
 * learning + LLM-research data model** (founded by Demis
 * Hassabis, Shane Legg, and Mustafa Suleyman in 2010 in
 * London, UK; acquired by Google in 2014 for ~$500M; merged
 * with Google Brain in 2023 to form the consolidated Google
 * DeepMind research org; ships Gemini (frontier multimodal
 * LLM family), AlphaFold (protein-folding), AlphaGo (board-
 * game RL), AlphaCode (code-generation), and Gemini
 * Robotics across the frontier-AI / foundation-model / AI-
 * research vertical — alongside competitors Anthropic,
 * OpenAI, and Meta AI — with a hybrid distributed workforce
 * concentrated across London (HQ), Mountain View, Zürich,
 * Paris, and Remote across the United Kingdom, the United
 * States, and Europe) — publishes its consolidated careers
 * board through Greenhouse at the bare slug `deepmind`
 * (case-asymmetric with the wire `company_name === 'DeepMind'`
 * PascalCase concat — same byte-count (8 bytes) but byte-
 * distinct via case at TWO indices: 0 (`D` vs `d`) and 4
 * (`M` vs `m`); see Spec 156 § 10 D-09).
 *
 * **One structural deviation from the AssemblyAI (Spec 108)
 * template** — D-09 sub-axis (consecutive-at-tail acronym
 * caps `AI` → non-consecutive segment-boundary caps
 * `Deep | Mind`).
 *
 *   - **D-04 — wire-shape variant 2 (canonical Greenhouse host).**
 *     `https://job-boards.greenhouse.io/deepmind/jobs/<id>`.
 *     **Sixty-second** plugin in the cohort to use variant 2.
 *
 *   - **D-08 — entity-decode-then-tag-strip description pipeline.**
 *     **One-hundred-and-twelfth** plugin to apply D-08.
 *
 *   - **D-09 — brand-name trim omitted with TWO-cap PascalCase
 *     case-asymmetric wire form.** Wire `company_name ===
 *     'DeepMind'` byte-for-byte (8 bytes — fully clean; 0 of
 *     73 padded). Slug `deepmind` is 8 bytes lowercase;
 *     case-asymmetric at TWO byte indices: 0 (`D` vs `d`)
 *     and 4 (`M` vs `m`). Caps mark the segment boundary of
 *     `Deep | Mind`. **9th cohort plugin with TWO-cap
 *     PascalCase D-09 sub-axis** after SoFi (caps 0/2),
 *     StockX (caps 0/5), xAI (caps 0/2 lowercase first),
 *     LaunchDarkly (caps 0/6), PagerDuty (caps 0/5),
 *     ComplyAdvantage (caps 0/6), GoCardless (caps 0/2), and
 *     BitGo (caps 0/3). **NEW caps-at-0/4 sub-pattern** —
 *     distinct from all prior TWO-cap PascalCase plugins.
 *     **One-hundred-and-third cohort plugin to omit D-09**.
 *
 *   - **D-10 — wire-title `.trim()` applied (trailing-pad form).**
 *     9 of 73 wire titles in the run-366 probe carry trailing
 *     ASCII-space padding (~12.3 % pad rate, all trailing-
 *     only — `'Program Manager, AI Infrastructure
 *     Operations, 12 Months FTC '`, `'Research Engineer,
 *     Applied AI '`, `'Security Lead, Agentic Red Team '`,
 *     plus 6 others). **Seventieth cohort plugin to apply
 *     D-10 — the cohort crosses the 70-plugin D-10-
 *     application threshold at this run.**
 *
 *   - **D-11 — wire-dept `.trim()` applied (trailing-pad form).**
 *     1 of 5 unique wire department names padded
 *     (`'Frontier AI '`); listing-level pad rate 14 of 73
 *     (~19.2 %). The plugin applies `.trim()` to the wire
 *     `departments[0].name` byte-for-byte before downstream
 *     emit. **Seventeenth cohort plugin to apply D-11**.
 *
 * **First cohort observation** of TWO-cap PascalCase plugin
 * with **both D-10 and D-11 applied** — all prior TWO-cap
 * PascalCase plugins applied at most one of D-10 / D-11.
 */
const API_URL = 'https://api.greenhouse.io/v1/boards/deepmind/jobs';

@SourcePlugin({
  site: Site.DEEPMIND,
  name: 'DeepMind',
  category: 'company',
})
@Injectable()
export class DeepmindService implements IScraper {
  private readonly logger = new Logger(DeepmindService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const jobs: JobPostDto[] = [];
    const resultsWanted = input.resultsWanted ?? 50;

    try {
      const client = createHttpClient({
        proxies: input.proxies,
        timeout: input.requestTimeout ?? 30,
      });

      const url = `${API_URL}?content=true`;
      this.logger.log(`DeepMind: fetching ${url}`);

      const { data } = await client.get<any>(url);
      const listings = data?.jobs ?? [];

      for (const listing of listings) {
        if (jobs.length >= resultsWanted) break;

        // D-10 applied (trailing-pad form): 9/73 wire titles
        // padded (~12.3 %).
        const title = (listing.title ?? '').trim();
        if (!title) continue;

        // D-11 applied (trailing-pad form): 1/5 unique wire
        // department names padded (`'Frontier AI '`); 14/73
        // listings affected.
        const department = (listing.departments?.[0]?.name ?? '').trim() || null;

        if (input.searchTerm) {
          const term = input.searchTerm.toLowerCase();
          const titleMatch = title.toLowerCase().includes(term);
          const deptMatch = (department ?? '').toLowerCase().includes(term);
          if (!titleMatch && !deptMatch) continue;
        }

        const jobId = listing.id ?? '';
        const id = `deepmind-${jobId}`;

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
            site: Site.DEEPMIND,
            title,
            // D-09 omitted: TWO-cap PascalCase case-asymmetric
            // wire form 'DeepMind' (caps 0/4 — NEW sub-pattern).
            companyName: listing.company_name ?? 'DeepMind',
            // D-04: wire `absolute_url` flows through (variant 2).
            jobUrl:
              listing.absolute_url ??
              `https://job-boards.greenhouse.io/deepmind/jobs/${listing.id}`,
            location,
            description: listing.content
              ? stripHtmlTags(decodeHtmlEntities(listing.content))
              : null,
            datePosted: listing.updated_at ?? null,
            isRemote: locationStr?.toLowerCase().includes('remote') ?? false,
            department,
          }),
        );
      }

      this.logger.log(`DeepMind: scraped ${jobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`DeepMind scrape failed: ${err.message}`);
      // Report WHY, and keep whatever was accumulated: the catch is outside
      // the loop, so a board that parsed jobs before failing still returns
      // them. Resolving rather than throwing is deliberate - the breaker
      // counts failures only on rejection.
      return new JobResponseDto(jobs, classifyScrapeError(err));
    }

    return new JobResponseDto(jobs);
  }
}
