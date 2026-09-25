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
 * Adobe — Software (HQ: San Jose, CA, USA).
 *
 * Source (Spec 1736): Workday board, scraped in this order:
 *   - `adobe:5:external_experienced` — https://adobe.wd5.myworkdayjobs.com/external_experienced
 *     verified live 2026-09-24: 583 open postings.
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
 * Tags: segment=workday-enterprise; industry=software.
 */
const COMPANY_NAME = 'Adobe';
const ID_PREFIX = 'adobe-';

/** Delegated boards, in scrape order. */
const BOARDS: ReadonlyArray<{ readonly companySlug: string; readonly atsIdPrefix: string }> = [
  { companySlug: 'adobe:5:external_experienced', atsIdPrefix: 'wd-adobe-' },
];

/** Trailing legal-form words ignored when comparing an organisation name with COMPANY_NAME. */
const LEGAL_FORM_WORDS: ReadonlySet<string> = new Set([
  'inc',
  'incorporated',
  'llc',
  'corp',
  'corporation',
  'co',
  'company',
  'ltd',
  'limited',
  'lp',
  'llp',
  'plc',
  'gmbh',
  'ag',
  'sa',
  'nv',
  'bv',
]);

/**
 * A company name reduced to its core: lower case, '&' read as 'and',
 * punctuation dropped, no leading 'The', no trailing legal form.
 */
function coreCompanyName(name: string): string {
  const words = name
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[.'\u2019]/g, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  while (words.length > 1 && LEGAL_FORM_WORDS.has(words[words.length - 1])) words.pop();
  while (words.length > 1 && words[0] === 'the') words.shift();
  return words.join(' ');
}

/**
 * Company name for a delegated posting (Spec 1735 §4.2.1). Workday reports each
 * posting's hiring organisation; on a multi-business tenant that names the
 * business unit, which is kept. Only what is not a real organisation name is
 * re-stamped: empty, the tenant token the adapter falls back to, or
 * COMPANY_NAME in legal form (e.g. "<name>, Inc.").
 */
function companyNameFor(sourceName: string | null | undefined, tenant: string): string {
  const name = sourceName?.trim();
  if (!name || name.toLowerCase() === tenant.toLowerCase()) return COMPANY_NAME;
  return coreCompanyName(name) === coreCompanyName(COMPANY_NAME) ? COMPANY_NAME : name;
}

@SourcePlugin({
  site: Site.ADOBE,
  name: COMPANY_NAME,
  category: 'company',
  companyDomains: ['adobe.com'],
  description: 'Adobe careers via Workday. Tags: segment=workday-enterprise; industry=software.',
})
@Injectable()
export class AdobeService implements IScraper {
  private readonly logger = new Logger(AdobeService.name);

  constructor(@Optional() private readonly registry?: PluginRegistry) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const backend = this.registry?.getScraper(Site.WORKDAY);
    if (!backend) {
      this.logger.error('Workday source plugin is not registered; cannot scrape Adobe');
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
      this.logger.log(`Adobe: delegating to Workday (${board.companySlug})`);

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
        job.site = Site.ADOBE;
        job.companyName = companyNameFor(job.companyName, board.companySlug.split(':')[0]);
        if (job.id?.startsWith(board.atsIdPrefix)) {
          job.id = ID_PREFIX + job.id.slice(board.atsIdPrefix.length);
        }
        const key = job.id ?? job.jobUrl ?? job.title;
        if (key && seen.has(key)) continue;
        if (key) seen.add(key);
        jobs.push(job);
      }
    }

    this.logger.log(`Adobe: scraped ${jobs.length} jobs`);
    // An actionable reason always surfaces (with jobs it reads as partial);
    // a benign one (e.g. empty) only when nothing was found at all.
    const diagnostics = actionable ?? (jobs.length === 0 ? fallback : undefined);
    return new JobResponseDto(jobs, diagnostics);
  }
}
