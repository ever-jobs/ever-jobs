import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  ACTIONABLE_SCRAPE_REASONS,
  classifyScrapeError,
  IScraper,
  JobPostDto,
  JobResponseDto,
  ScrapeDiagnostics,
  ScraperInputDto,
  Site,
} from '@ever-jobs/models';

/**
 * McKesson — Healthcare distribution (HQ: Irving, TX, USA).
 *
 * Source (Spec 1736): Workday board, scraped in this order:
 *   - `mckesson:3:External_Careers` — https://mckesson.wd3.myworkdayjobs.com/External_Careers
 *     verified live 2026-09-24: 573 open postings.
 *
 * The plugin re-implements no parsing. It resolves the registered Workday
 * source plugin from the PluginRegistry at runtime, delegates each board in
 * turn (sequentially, early-career boards first, each with the remaining
 * resultsWanted budget), then re-stamps the company identity (site,
 * companyName, id prefix) so every Workday field fix is inherited and no
 * plugin imports a peer. The search term and every other caller input pass
 * through untouched, except credentials: auth is never forwarded to a third
 * party board.
 *
 * Tags: segment=workday-enterprise; industry=healthcare-distribution.
 */
const COMPANY_NAME = 'McKesson';
const ID_PREFIX = 'mckesson-';

/** Delegated boards, in scrape order. */
const BOARDS: ReadonlyArray<{ readonly companySlug: string; readonly atsIdPrefix: string }> = [
  { companySlug: 'mckesson:3:External_Careers', atsIdPrefix: 'wd-mckesson-' },
];

@SourcePlugin({
  site: Site.MCKESSON,
  name: COMPANY_NAME,
  category: 'company',
  companyDomains: ['mckesson.com'],
  description: 'McKesson careers via Workday. Tags: segment=workday-enterprise; industry=healthcare-distribution.',
})
@Injectable()
export class McKessonService implements IScraper {
  private readonly logger = new Logger(McKessonService.name);

  constructor(@Optional() private readonly registry?: PluginRegistry) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const backend = this.registry?.getScraper(Site.WORKDAY);
    if (!backend) {
      this.logger.error('Workday source plugin is not registered; cannot scrape McKesson');
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Workday source plugin is not registered'),
      );
    }

    const wanted = input.resultsWanted;
    const jobs: JobPostDto[] = [];
    const seen = new Set<string>();
    let actionable: ScrapeDiagnostics | undefined;
    let fallback: ScrapeDiagnostics | undefined;

    for (const board of BOARDS) {
      const remaining = wanted == null ? undefined : wanted - jobs.length;
      if (remaining !== undefined && remaining <= 0) break;
      this.logger.log(`McKesson: delegating to Workday (${board.companySlug})`);

      let result: JobResponseDto;
      try {
        result = await backend.scrape({
          ...input,
          // Never forward the caller's credentials to a third party's board
          // (Spec 1735 §4.5): an authenticated ATS path would answer with the
          // caller's own jobs under this company's name.
          auth: undefined,
          companySlug: board.companySlug,
          ...(remaining !== undefined ? { resultsWanted: remaining } : {}),
        } as ScraperInputDto);
      } catch (err: unknown) {
        // Adapters resolve rather than throw; classify a regression instead of
        // letting one board sink the fan-out.
        actionable = actionable ?? classifyScrapeError(err);
        continue;
      }

      const diagnostics = result.diagnostics;
      if (diagnostics) {
        if (ACTIONABLE_SCRAPE_REASONS.includes(diagnostics.reason)) {
          actionable = actionable ?? diagnostics;
        } else {
          fallback = fallback ?? diagnostics;
        }
      }

      for (const job of result.jobs ?? []) {
        job.site = Site.MCKESSON;
        job.companyName = COMPANY_NAME;
        if (job.id?.startsWith(board.atsIdPrefix)) {
          job.id = ID_PREFIX + job.id.slice(board.atsIdPrefix.length);
        }
        const key = job.id ?? job.jobUrl ?? job.title;
        if (key && seen.has(key)) continue;
        if (key) seen.add(key);
        jobs.push(job);
      }
    }

    this.logger.log(`McKesson: scraped ${jobs.length} jobs`);
    // An actionable reason always surfaces (with jobs it reads as partial);
    // a benign one (e.g. empty) only when nothing was found at all.
    const diagnostics = actionable ?? (jobs.length === 0 ? fallback : undefined);
    return new JobResponseDto(jobs, diagnostics);
  }
}
