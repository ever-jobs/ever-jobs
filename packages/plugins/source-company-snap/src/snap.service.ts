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
 * Snap Inc. — Social media (HQ: Santa Monica, CA, USA).
 *
 * Source (Spec 1736): Workday board, scraped in this order:
 *   - `snapchat:1:snap` — https://snapchat.wd1.myworkdayjobs.com/snap
 *     verified live 2026-09-24: 179 open postings.
 *
 * The plugin re-implements no parsing. It resolves the registered Workday
 * source plugin from the PluginRegistry at runtime, delegates each board in
 * turn (sequentially, early-career boards first, each with the remaining
 * resultsWanted budget), then re-stamps the company identity (site,
 * companyName, id prefix) so every Workday field fix is inherited and no
 * plugin imports a peer. The search term and every other caller input pass
 * through untouched.
 *
 * Tags: segment=workday-enterprise; industry=social-media.
 */
const COMPANY_NAME = 'Snap Inc.';
const ID_PREFIX = 'snap-';

/** Delegated boards, in scrape order. */
const BOARDS: ReadonlyArray<{ readonly companySlug: string; readonly atsIdPrefix: string }> = [
  { companySlug: 'snapchat:1:snap', atsIdPrefix: 'wd-snapchat-' },
];

@SourcePlugin({
  site: Site.SNAP,
  name: COMPANY_NAME,
  category: 'company',
  companyDomains: ['snap.com'],
  description: 'Snap Inc. careers via Workday. Tags: segment=workday-enterprise; industry=social-media.',
})
@Injectable()
export class SnapService implements IScraper {
  private readonly logger = new Logger(SnapService.name);

  constructor(@Optional() private readonly registry?: PluginRegistry) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const backend = this.registry?.getScraper(Site.WORKDAY);
    if (!backend) {
      this.logger.error('Workday source plugin is not registered; cannot scrape Snap Inc.');
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
      this.logger.log(`Snap Inc.: delegating to Workday (${board.companySlug})`);

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
        job.site = Site.SNAP;
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

    this.logger.log(`Snap Inc.: scraped ${jobs.length} jobs`);
    // An actionable reason always surfaces (with jobs it reads as partial);
    // a benign one (e.g. empty) only when nothing was found at all.
    const diagnostics = actionable ?? (jobs.length === 0 ? fallback : undefined);
    return new JobResponseDto(jobs, diagnostics);
  }
}
