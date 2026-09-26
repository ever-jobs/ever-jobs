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
import { siteFromDomain } from '@ever-jobs/common';

/**
 * Susquehanna International Group (SIG) — Quantitative trading (HQ: Bala Cynwyd, PA, USA).
 *
 * Source (Spec 1737): iCIMS board, scraped in this order:
 *   - `careers-sig` — https://careers-sig.icims.com/jobs/search
 *     verified live 2026-09-24: 20+ open postings (first listing page).
 *
 * The plugin re-implements no parsing. It resolves the registered iCIMS
 * source plugin from the PluginRegistry at runtime, delegates each board in
 * turn (sequentially, early-career boards first, each with the remaining
 * resultsWanted budget), then re-stamps the company identity (site,
 * companyName, id prefix) so every iCIMS field fix is inherited and no
 * plugin imports a peer. The search term and every other caller input pass
 * through untouched, except credentials: auth is never forwarded to a third
 * party board.
 *
 * Tags: segment=quant-trading; industry=quantitative-trading.
 */
const COMPANY_NAME = 'Susquehanna International Group (SIG)';
const ID_PREFIX = 'sig-';

/** Delegated boards, in scrape order. */
const BOARDS: ReadonlyArray<{ readonly companySlug: string; readonly atsIdPrefix: string }> = [
  { companySlug: 'careers-sig', atsIdPrefix: 'icims-careers-sig-' },
];

/** Why this plugin runs only when a caller selects it explicitly (Spec 1735 §4.7). */
const EXPLICIT_ONLY_REASON = 'careers-sig.icims.com robots.txt disallows every crawler (User-agent: *, Disallow: /; checked 2026-09-25)';

@SourcePlugin({
  site: Site.SIG,
  name: COMPANY_NAME,
  category: 'company',
  companyDomains: ['sig.com'],
  description: 'Susquehanna International Group (SIG) careers via iCIMS. Tags: segment=quant-trading; industry=quantitative-trading.',
})
@Injectable()
export class SigService implements IScraper {
  private readonly logger = new Logger(SigService.name);

  constructor(@Optional() private readonly registry?: PluginRegistry) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    if (!this.isExplicitlySelected(input)) {
      // The default fan-out never contacts this board (Spec 1735 §4.7).
      this.logger.debug(`Susquehanna International Group (SIG): not selected explicitly, skipped (${EXPLICIT_ONLY_REASON})`);
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('empty', `explicit-only source, not selected: ${EXPLICIT_ONLY_REASON}`),
      );
    }

    const backend = this.registry?.getScraper(Site.ICIMS);
    if (!backend) {
      this.logger.error('iCIMS source plugin is not registered; cannot scrape Susquehanna International Group (SIG)');
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'iCIMS source plugin is not registered'),
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
      this.logger.log(`Susquehanna International Group (SIG): delegating to iCIMS (${board.companySlug})`);

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
        job.site = Site.SIG;
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

    this.logger.log(`Susquehanna International Group (SIG): scraped ${jobs.length} jobs`);
    // An actionable reason always surfaces (with jobs it reads as partial);
    // a benign one (e.g. empty) only when nothing was found at all.
    const diagnostics = actionable ?? (jobs.length === 0 ? fallback : undefined);
    return new JobResponseDto(jobs, diagnostics);
  }

  /**
   * True when the caller selected this plugin (Spec 1735 §4.7): its Site is in
   * siteType, or a companyDomain resolves to it the way JobsService resolves
   * domains. The default fan-out passes neither.
   */
  private isExplicitlySelected(input: ScraperInputDto): boolean {
    if (input.siteType?.includes(Site.SIG)) return true;
    return (input.companyDomain ?? []).some((raw) => {
      const domain = typeof raw === 'string' ? raw.trim() : '';
      if (!domain) return false;
      return (this.registry?.siteForDomain(domain) ?? siteFromDomain(domain)) === Site.SIG;
    });
  }
}
