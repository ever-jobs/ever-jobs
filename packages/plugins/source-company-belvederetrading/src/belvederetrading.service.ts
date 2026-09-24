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
 * Belvedere Trading — Options market making (HQ: Chicago, IL, USA).
 *
 * Source (Spec 1737): Lever board, scraped in this order:
 *   - `belvederetrading` — https://jobs.lever.co/belvederetrading
 *     verified live 2026-09-24: 21 open postings.
 *
 * The plugin re-implements no parsing. It resolves the registered Lever
 * source plugin from the PluginRegistry at runtime, delegates each board in
 * turn (sequentially, early-career boards first, each with the remaining
 * resultsWanted budget), then re-stamps the company identity (site,
 * companyName, id prefix) so every Lever field fix is inherited and no
 * plugin imports a peer. The search term and every other caller input pass
 * through untouched.
 *
 * Tags: segment=quant-trading; industry=options-market-making.
 */
const COMPANY_NAME = 'Belvedere Trading';
const ID_PREFIX = 'belvederetrading-';

/** Delegated boards, in scrape order. */
const BOARDS: ReadonlyArray<{ readonly companySlug: string; readonly atsIdPrefix: string }> = [
  { companySlug: 'belvederetrading', atsIdPrefix: 'lever-' },
];

@SourcePlugin({
  site: Site.BELVEDERE_TRADING,
  name: COMPANY_NAME,
  category: 'company',
  companyDomains: ['belvederetrading.com'],
  description: 'Belvedere Trading careers via Lever. Tags: segment=quant-trading; industry=options-market-making.',
})
@Injectable()
export class BelvedereTradingService implements IScraper {
  private readonly logger = new Logger(BelvedereTradingService.name);

  constructor(@Optional() private readonly registry?: PluginRegistry) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const backend = this.registry?.getScraper(Site.LEVER);
    if (!backend) {
      this.logger.error('Lever source plugin is not registered; cannot scrape Belvedere Trading');
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
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
      this.logger.log(`Belvedere Trading: delegating to Lever (${board.companySlug})`);

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
        job.site = Site.BELVEDERE_TRADING;
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

    this.logger.log(`Belvedere Trading: scraped ${jobs.length} jobs`);
    // An actionable reason always surfaces (with jobs it reads as partial);
    // a benign one (e.g. empty) only when nothing was found at all.
    const diagnostics = actionable ?? (jobs.length === 0 ? fallback : undefined);
    return new JobResponseDto(jobs, diagnostics);
  }
}
