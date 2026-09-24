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
 * Cox Enterprises — Communications and automotive (HQ: Atlanta, GA, USA).
 *
 * Source (Spec 1736): Workday board, scraped in this order:
 *   - `cox:1:Cox_External_Career_Site_1` — https://cox.wd1.myworkdayjobs.com/Cox_External_Career_Site_1
 *     verified live 2026-09-24: 754 open postings.
 *
 * The plugin re-implements no parsing. It resolves the registered Workday
 * source plugin from the PluginRegistry at runtime, delegates each board in
 * turn (sequentially, early-career boards first, each with the remaining
 * resultsWanted budget), then re-stamps the company identity (site,
 * companyName, id prefix) so every Workday field fix is inherited and no
 * plugin imports a peer. The search term and every other caller input pass
 * through untouched.
 *
 * Tags: segment=workday-enterprise; industry=communications-and-automotive.
 */
const COMPANY_NAME = 'Cox Enterprises';
const ID_PREFIX = 'coxenterprises-';

/** Delegated boards, in scrape order. */
const BOARDS: ReadonlyArray<{ readonly companySlug: string; readonly atsIdPrefix: string }> = [
  { companySlug: 'cox:1:Cox_External_Career_Site_1', atsIdPrefix: 'wd-cox-' },
];

@SourcePlugin({
  site: Site.COX_ENTERPRISES,
  name: COMPANY_NAME,
  category: 'company',
  companyDomains: ['coxenterprises.com'],
  description: 'Cox Enterprises careers via Workday. Tags: segment=workday-enterprise; industry=communications-and-automotive.',
})
@Injectable()
export class CoxEnterprisesService implements IScraper {
  private readonly logger = new Logger(CoxEnterprisesService.name);

  constructor(@Optional() private readonly registry?: PluginRegistry) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const backend = this.registry?.getScraper(Site.WORKDAY);
    if (!backend) {
      this.logger.error('Workday source plugin is not registered; cannot scrape Cox Enterprises');
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
      this.logger.log(`Cox Enterprises: delegating to Workday (${board.companySlug})`);

      let result: JobResponseDto;
      try {
        result = await backend.scrape({
          ...input,
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
        job.site = Site.COX_ENTERPRISES;
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

    this.logger.log(`Cox Enterprises: scraped ${jobs.length} jobs`);
    // An actionable reason always surfaces (with jobs it reads as partial);
    // a benign one (e.g. empty) only when nothing was found at all.
    const diagnostics = actionable ?? (jobs.length === 0 ? fallback : undefined);
    return new JobResponseDto(jobs, diagnostics);
  }
}
