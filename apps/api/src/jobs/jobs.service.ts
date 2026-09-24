import { OnModuleInit, Injectable, Logger, Optional, BadRequestException } from '@nestjs/common';
import {
  Site, ScraperInputDto, JobPostDto, JobResponseDto, IScraper,
  Country, SalarySource, CompensationDto,
  ERR_SOURCE_CIRCUIT_OPEN,
  SourceDiagnosticDto, ScrapeReason, ScrapeDiagnostics, classifyScrapeError,
} from '@ever-jobs/models';
import {
  extractSalary, convertToAnnual, siteFromDomain, deriveSiteToken, resolveCompanyUrl,
} from '@ever-jobs/common';
import { ConfigService } from '@nestjs/config';
import { PluginRegistry, CircuitBreakerInterceptor, IPluginMetadata } from '@ever-jobs/plugin';
import { MetricsService } from '../metrics/metrics.service';
import {
  SearchRunOptions,
  describeTerm,
  isListMode,
  normalizeSearchInput,
  parseSiteCategories,
} from './search-input';

/**
 * Detail carried by the per-source row of a plugin that was not dispatched
 * because it needs a keyword and the request is in list mode (Spec 1720).
 */
export const LIST_MODE_SKIPPED_DETAIL =
  'requires a searchTerm; not queried in list mode (Spec 1720)';

/**
 * Default ceiling on simultaneously-dispatched sources (Spec 5026).
 *
 * Chosen to bound peak memory without materially regressing latency for the
 * *narrow* selections that dominate real traffic. Peak in-flight state becomes
 * `concurrency × (response body + parsed DOM + result array)` instead of
 * `sources × (…)` — with the catalogue at ~1.8k sources that is roughly a
 * 28× reduction in worst-case simultaneous allocation.
 *
 * Note the trade-off: for a genuinely catalogue-wide search this serialises
 * work into ~28 waves, so wall-clock goes up. The real fix for width is to
 * stop defaulting `siteType` to the entire catalogue (see the spec's
 * follow-up) — this constant is the safety net, not the cure.
 *
 * Override with `EVER_JOBS_SEARCH_CONCURRENCY`.
 */
export const DEFAULT_SEARCH_CONCURRENCY = 64;

/**
 * Default wall-clock budget for one fan-out, milliseconds (Spec 5026).
 *
 * Matches the Hust client's own abort (`DEFAULT_FETCH_TIMEOUT_MS = 120_000`):
 * past this point nobody is waiting for the answer, so continuing to schedule
 * sources only burns memory in a handler whose response will be discarded.
 * Sources already in flight are allowed to finish.
 *
 * `0` (or negative) disables the deadline. Override with
 * `EVER_JOBS_FANOUT_DEADLINE_MS` (Spec 1721; the older
 * `EVER_JOBS_SEARCH_DEADLINE_MS` still works as a fallback).
 */
export const DEFAULT_SEARCH_DEADLINE_MS = 120_000;

/**
 * Upper bound accepted for `search.concurrency` (Spec 5026).
 *
 * A misconfigured `EVER_JOBS_SEARCH_CONCURRENCY` must not be able to restore
 * the unbounded fan-out. `Infinity`, `NaN`, and values above this ceiling all
 * fall back to {@link DEFAULT_SEARCH_CONCURRENCY} rather than being honoured.
 */
export const MAX_SEARCH_CONCURRENCY = 512;

/**
 * Normalise a configured concurrency into `[1, MAX_SEARCH_CONCURRENCY]`.
 * Non-finite or out-of-range input resolves to
 * {@link DEFAULT_SEARCH_CONCURRENCY} — silently honouring `Infinity` would
 * spawn one worker per source and defeat the whole bound.
 */
export function clampConcurrency(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || n < 1 || n > MAX_SEARCH_CONCURRENCY) {
    return DEFAULT_SEARCH_CONCURRENCY;
  }
  return Math.floor(n);
}

/**
 * Reject `promise` once `deadlineAt` passes (Spec 5026).
 *
 * The deadline check in the worker loop only stops us *starting* new sources.
 * Without this race, a single source whose socket never settles keeps its
 * worker pending forever, `Promise.allSettled` never resolves, and the whole
 * `searchJobs` handler is pinned — exactly the zombie-handler failure mode the
 * deadline was added to prevent.
 *
 * The underlying `scrapeOne` promise cannot be cancelled (no AbortSignal in
 * the plugin contract yet — see spec task T11), so it keeps running detached
 * until it settles or its own HTTP timeout fires. What this guarantees is that
 * the *handler* returns and the response is sent, rather than the request
 * living as long as the slowest hung socket.
 *
 * The timer is always cleared, so a fast source leaves nothing behind.
 */
function withDeadline<T>(
  promise: Promise<T>,
  deadlineAt: number,
  site: Site,
): Promise<T> {
  const remaining = deadlineAt - Date.now();
  if (!Number.isFinite(remaining)) return promise;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${site}: abandoned (search deadline exceeded mid-flight)`)),
      Math.max(0, remaining),
    );
  });

  return Promise.race([promise, expiry]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  }) as Promise<T>;
}

/**
 * Central orchestration service for job searching.
 *
 * All individual scraper injections have been replaced by a single
 * PluginRegistry injection. The registry is automatically populated
 * at bootstrap by PluginDiscoveryService scanning for @SourcePlugin()
 * decorated services.
 */
@Injectable()
export class JobsService implements OnModuleInit {
  private readonly logger = new Logger(JobsService.name);

  constructor(
    private readonly registry: PluginRegistry,
    private readonly configService: ConfigService,
    private readonly metrics: MetricsService,
    /**
     * Spec 005 / T04 — when {@link CircuitBreakerModule} is imported by
     * {@link JobsModule} this is bound and every per-site `scrape()` call
     * is wrapped in {@link CircuitBreakerInterceptor.wrap}. When the
     * interceptor is *not* bound the service degrades to the prior
     * behaviour (raw `scraper.scrape()` call, no breaker enforcement) so
     * test bootstraps that don't import the breaker module keep working.
     */
    @Optional() private readonly circuitBreaker?: CircuitBreakerInterceptor,
  ) {}

  onModuleInit() {
    this.logger.log(
      `JobsService initialized with ${this.registry.size} source plugins`,
    );

    // Log all registered sources for debugging
    const sources = this.registry.listSources();
    for (const source of sources) {
      this.logger.debug(`  → ${source.site}: ${source.name} (${source.category})`);
    }
  }

  /**
   * Orchestrates concurrent searching across selected sites.
   * Runs all selected source modules in parallel via Promise.allSettled.
   *
   * Routing rules (when no explicit siteType or companyDomain is provided):
   * - If `companySlug` provided → only ATS scrapers run (they need a slug)
   * - Otherwise → search + company scrapers run (ATS scrapers skipped)
   *
   * When `siteType` or `companyDomain` is provided, the resolved set is used
   * regardless of `companySlug`. `companyDomain` values are mapped to `Site`
   * tokens via `siteFromDomain`; unresolved domains throw `BadRequestException`.
   */
  async searchJobs(input: ScraperInputDto): Promise<JobPostDto[]> {
    return (await this.searchJobsWithDiagnostics(input)).jobs;
  }

  /**
   * Like {@link searchJobs} but also returns a per-source outcome breakdown
   * (Spec 5082): one {@link SourceDiagnosticDto} per fanned-out source with its
   * count and a categorized `reason`, so a caller can tell an empty board apart
   * from a blocked/errored source. `searchJobs` is a thin wrapper over this.
   */
  async searchJobsWithDiagnostics(
    input: ScraperInputDto,
    options: SearchRunOptions = {},
  ): Promise<{ jobs: JobPostDto[]; perSource: SourceDiagnosticDto[] }> {
    // Spec 1720 — one keyword semantics for every entry point: omitted, null,
    // "" and whitespace-only all mean list mode and reach plugins as an absent
    // `searchTerm`, never as "undefined"/"null"/"   ".
    normalizeSearchInput(input);
    const listMode = isListMode(input);
    const categories = parseSiteCategories(input.siteCategories);

    const atsSites = new Set<Site>(this.registry.listAtsSites());
    const { resolved: resolvedSites, unresolved: unresolvedDomains } =
      this.resolveCompanyDomains(input.companyDomain);
    let effectiveSites = this.buildEffectiveSites(input.siteType, resolvedSites);

    // If no explicit site is selected, fall back to an unambiguous canonical
    // ATS board URL in `companyUrl`. The host selects the plugin and the first
    // path segment provides `companySlug` when it is not already set.
    const companyUrlFallback = resolveCompanyUrl(input.companyUrl);
    if (effectiveSites.length === 0 && companyUrlFallback.site) {
      effectiveSites = [companyUrlFallback.site];
    }
    // Only when that provider is the *sole* selection. `companySlug` is shared
    // by every scraper in the fan-out, so writing a Greenhouse tenant into it
    // while Ashby is also selected sends Ashby to a board that is not its own
    // (raised by Greptile on PR #87).
    if (
      companyUrlFallback.site &&
      !input.companySlug &&
      companyUrlFallback.slug &&
      effectiveSites.length === 1 &&
      effectiveSites[0] === companyUrlFallback.site
    ) {
      input.companySlug = companyUrlFallback.slug;
    }

    if (effectiveSites.length === 0 && unresolvedDomains.length > 0) {
      const messages = unresolvedDomains.map(
        (domain) =>
          `domain \`${domain}\` → token \`${deriveSiteToken(domain)}\` is not a registered plugin`,
      );
      throw new BadRequestException(messages.join('; '));
    }

    let sites: Site[];

    if (effectiveSites.length) {
      // Explicit site selection (from siteType and/or companyDomain) — respect it
      sites = effectiveSites;
    } else if (input.companySlug) {
      // companySlug provided but no explicit sites → ATS scrapers only
      sites = [...atsSites];
    } else {
      // Default: search + company scrapers (skip ATS — they need a slug)
      sites = this.registry.listSiteKeys().filter(
        (s: Site) => !atsSites.has(s),
      );
    }

    // Spec 1720 — plugin metadata drives both the category filter and the
    // list-mode keyword check. One pass per request (~1.9k entries).
    const metadataBySite = new Map<string, IPluginMetadata>(
      this.registry.listSources().map((meta) => [meta.site, meta]),
    );
    if (categories) {
      if (effectiveSites.length) {
        this.logger.debug(
          `siteCategories [${[...categories].join(', ')}] ignored: siteType/companyDomain selection wins`,
        );
      } else {
        // Narrow the DEFAULT selection computed above, so ATS plugins keep
        // needing a companySlug exactly as they do without the filter.
        sites = sites.filter((site) => {
          const category = metadataBySite.get(site)?.category;
          return category !== undefined && categories.has(category);
        });
      }
    }

    const selectedScrapers: { site: Site; scraper: IScraper }[] = [];
    const keywordSkipped: Site[] = [];

    for (const site of sites) {
      const scraper = this.registry.getScraper(site);
      if (!scraper) {
        this.logger.warn(`Unknown site: ${site}`);
        continue;
      }
      if (listMode && metadataBySite.get(site)?.requiresSearchTerm) {
        this.logger.debug(`${site}: ${LIST_MODE_SKIPPED_DETAIL}`);
        keywordSkipped.push(site);
        continue;
      }
      selectedScrapers.push({ site, scraper });
    }
    const keywordSkippedRows = keywordSkipped.map(
      (site) => new SourceDiagnosticDto(site, 0, 'empty', LIST_MODE_SKIPPED_DETAIL),
    );

    if (selectedScrapers.length === 0) {
      this.logger.warn('No valid scrapers selected');
      return { jobs: [], perSource: keywordSkippedRows };
    }

    // Spec 5026 — bounded fan-out. Previously this was a bare
    // `Promise.allSettled(selectedScrapers.map(...))`, i.e. every selected
    // source dispatched at once. Because `ScraperInputDto`'s constructor
    // defaults `siteType` to `Object.values(Site)` and `ValidationPipe({
    // transform: true })` runs that constructor, the default selection is the
    // ENTIRE catalogue — so a single request opened ~1.8k concurrent HTTP
    // conversations and held every response body, parsed DOM and result array
    // in memory simultaneously. Peak memory is now O(concurrency), not
    // O(sources).
    // Clamped, not just floored. `Math.max(1, x)` alone would happily accept
    // `Infinity` or `1e9` — and since the pool spawns
    // `Math.min(concurrency, sources)` workers, either value silently restores
    // the unbounded fan-out this spec exists to prevent. A non-finite or
    // out-of-range setting falls back to the default rather than being
    // honoured.
    const concurrency = clampConcurrency(
      this.configService.get<number>('search.concurrency', DEFAULT_SEARCH_CONCURRENCY),
    );
    const deadlineMs = this.configService.get<number>(
      'search.deadlineMs',
      DEFAULT_SEARCH_DEADLINE_MS,
    );
    const deadlineAt =
      deadlineMs > 0 ? Date.now() + deadlineMs : Number.POSITIVE_INFINITY;

    this.logger.log(
      `Running ${selectedScrapers.length} scrapers (concurrency ${concurrency}, ` +
        `deadline ${deadlineMs > 0 ? `${deadlineMs}ms` : 'none'}, ` +
        `term=${describeTerm(input)}${listMode ? ' [list mode]' : ''}): ` +
        `${selectedScrapers.map((s) => s.site).join(', ')}`,
    );

    const results: PromiseSettledResult<JobResponseDto>[] = new Array(
      selectedScrapers.length,
    );
    let cursor = 0;
    let skipped = 0;

    // Spec 1721 — progress for the NDJSON heartbeat. A throwing listener must
    // never break the fan-out it is observing.
    let sourcesDone = 0;
    let jobsSoFar = 0;
    const reportProgress = (settled?: PromiseSettledResult<JobResponseDto>): void => {
      if (!options.onProgress) return;
      if (settled) {
        sourcesDone++;
        if (settled.status === 'fulfilled') jobsSoFar += settled.value?.jobs?.length ?? 0;
      }
      try {
        options.onProgress({
          sourcesDone,
          sourcesTotal: selectedScrapers.length,
          jobs: jobsSoFar,
        });
      } catch (err) {
        this.logger.warn(
          `progress listener threw (ignored): ${err instanceof Error ? err.message : err}`,
        );
      }
    };
    reportProgress();

    // Shared-cursor worker pool — same shape as
    // `LivenessHttpService.checkBatch` (Spec 721), which is the established
    // in-repo pattern for bounded fan-out.
    const worker = async (): Promise<void> => {
      for (;;) {
        const index = cursor++;
        if (index >= selectedScrapers.length) return;

        const { site, scraper } = selectedScrapers[index];

        // Past the deadline we stop STARTING work and drain the remaining
        // queue as skipped. Already-running scrapers are left to finish (they
        // carry their own per-source timeouts and retry budgets); the point is
        // to bound how long the handler can live, not to abandon in-flight
        // sockets mid-read.
        if (Date.now() >= deadlineAt) {
          skipped++;
          this.metrics.scraperRequestsTotal.inc({ site, status: 'deadline_skipped' });
          results[index] = {
            status: 'rejected',
            reason: new Error(`${site}: skipped (search deadline exceeded)`),
          };
          reportProgress(results[index]);
          continue;
        }

        try {
          // Race against the deadline as well as checking it before starting:
          // a source that never settles would otherwise keep this worker (and
          // therefore the whole handler) pending indefinitely.
          results[index] = {
            status: 'fulfilled',
            value: await withDeadline(
              this.scrapeOne(site, scraper, input),
              deadlineAt,
              site,
            ),
          };
        } catch (err) {
          results[index] = { status: 'rejected', reason: err };
        }
        reportProgress(results[index]);
      }
    };

    await Promise.allSettled(
      Array.from({ length: Math.min(concurrency, selectedScrapers.length) }, () =>
        worker(),
      ),
    );

    if (skipped > 0) {
      this.logger.warn(
        `Search deadline (${deadlineMs}ms) exceeded — skipped ${skipped} of ` +
          `${selectedScrapers.length} sources. Raise EVER_JOBS_FANOUT_DEADLINE_MS ` +
          `or narrow siteType to cover more of the catalogue.`,
      );
    }
    // Aggregate results from fulfilled searches + derive a per-source outcome
    // (Spec 5082). The reason comes from the plugin's own diagnostics when it
    // set them (e.g. `browser_unavailable`, `blocked`); otherwise it is inferred
    // from the settled outcome: jobs → `ok`, empty → `empty`, thrown → classify.
    const allJobs: JobPostDto[] = [];
    const perSource: SourceDiagnosticDto[] = [];
    results.forEach((result, index) => {
      const site = selectedScrapers[index]?.site ?? 'unknown';
      if (result?.status === 'fulfilled') {
        const jobs = result.value.jobs;
        allJobs.push(...jobs);
        const diag = result.value.diagnostics;
        // A source that returned jobs AND reported a diagnostic is `partial`:
        // it got some of the board before something failed. Calling that `ok`
        // hid a partial outage behind a non-zero count, and left an `ok` row
        // carrying an error string in `detail`.
        const reason: ScrapeReason =
          jobs.length > 0 ? (diag ? 'partial' : 'ok') : (diag?.reason ?? 'empty');
        perSource.push(
          new SourceDiagnosticDto(site, jobs.length, reason, diag?.detail),
        );
      } else {
        // "We deliberately stopped calling this source" is its own operational
        // state, not an unclassifiable error — the breaker is already tracked
        // for metrics and logs, so don't collapse it to `unknown` here.
        const err = result?.reason as { code?: unknown } | undefined;
        const diag =
          err?.code === ERR_SOURCE_CIRCUIT_OPEN
            ? new ScrapeDiagnostics('circuit_open', `circuit open for ${site}`)
            : classifyScrapeError(result?.reason);
        perSource.push(new SourceDiagnosticDto(site, 0, diag.reason, diag.detail));
      }
    });

    // Post-processing: salary enrichment (mirrors Python __init__.py logic)
    for (const job of allJobs) {
      this.postProcessSalary(job, input);
    }

    // Sort by site name then by date (most recent first)
    allJobs.sort((a, b) => {
      const siteCompare = (a.site ?? '').localeCompare(b.site ?? '');
      if (siteCompare !== 0) return siteCompare;

      const dateA = a.datePosted ? new Date(a.datePosted as string).getTime() : 0;
      const dateB = b.datePosted ? new Date(b.datePosted as string).getTime() : 0;
      return dateB - dateA;
    });

    // Surface `companyDomain` values that did not map to a registered Site token as
    // diagnostics when the request still had at least one valid explicit selector (Spec 5095).
    for (const domain of unresolvedDomains) {
      perSource.push(
        new SourceDiagnosticDto(
          `companyDomain:${domain}`,
          0,
          'bad_input',
          `domain \`${domain}\` → token \`${deriveSiteToken(domain)}\` is not a registered plugin`,
        ),
      );
    }
    // Spec 1720 — keyword-only sources that list mode did not dispatch.
    perSource.push(...keywordSkippedRows);

    this.logger.log(`Total aggregated jobs: ${allJobs.length}`);
    return { jobs: allJobs, perSource };
  }

  /**
   * Dispatch a single source. Extracted from the fan-out loop by Spec 5026 so
   * the worker pool has a plain unit of work to schedule; the body is
   * unchanged from the prior inline closure.
   */
  private async scrapeOne(
    site: Site,
    scraper: IScraper,
    input: ScraperInputDto,
  ): Promise<JobResponseDto> {
    // Resolve retry policy for this source
    const globalRetry = this.configService.get('retry');
    const perSourceRetry = globalRetry.perSource?.[site] || {};

    const scraperInput = new ScraperInputDto({
      ...input,
      retries: input.retries ?? perSourceRetry.retries ?? globalRetry.defaultRetries,
      retryDelay: input.retryDelay ?? perSourceRetry.delayMs ?? globalRetry.defaultDelayMs,
      retryBackoff: input.retryBackoff ?? perSourceRetry.backoff ?? globalRetry.defaultBackoff,
      retryMaxDelay: input.retryMaxDelay ?? perSourceRetry.maxDelayMs ?? 30000,
    });

    this.logger.log(`Starting search for ${site} (retries=${scraperInput.retries}, backoff=${scraperInput.retryBackoff})`);
    const scraperStop = this.metrics.scraperDuration.startTimer({ site });
    try {
      // Spec 005 / T04 — wrap the per-source dispatch in the circuit
      // breaker when bound. The interceptor short-circuits with
      // `ERR_SOURCE_CIRCUIT_OPEN` once the breaker has tripped, which
      // we surface as a `circuit_open` metric status (not `error`) so
      // operators can distinguish "source down" from "we stopped
      // calling source" on the dashboard.
      const response = this.circuitBreaker
        ? await this.circuitBreaker.wrap(site, () => scraper.scrape(scraperInput))
        : await scraper.scrape(scraperInput);
      scraperStop();
      // Derive the metric from the diagnostic rather than from the promise
      // settling. A plugin that swallows its error resolves normally, so a
      // flat 'success' here reported a fully-failed scrape as a success and
      // every dashboard built on this counter was wrong.
      const outcome = response.diagnostics?.reason;
      this.metrics.scraperRequestsTotal.inc({
        site,
        status: !outcome ? 'success' : response.jobs.length > 0 ? 'partial' : outcome,
      });
      // Tag each job with the site it came from
      for (const job of response.jobs) {
        job.site = site;
      }
      this.logger.log(`${site}: found ${response.jobs.length} jobs`);
      return response;
    } catch (err: any) {
      scraperStop();
      const isCircuitOpen = err?.code === ERR_SOURCE_CIRCUIT_OPEN;
      this.metrics.scraperRequestsTotal.inc({
        site,
        status: isCircuitOpen ? 'circuit_open' : 'error',
      });
      if (isCircuitOpen) {
        // Breaker short-circuits are an *expected* fan-out outcome
        // for a degraded source — log at warn, not error, and keep
        // the message terse so logs stay readable.
        this.logger.warn(`${site}: skipped (circuit open)`);
      } else {
        this.logger.error(`${site} search failed: ${err.message}`);
      }
      throw err;
    }
  }

  /**
   * Resolves `companyDomain` values to registered `Site` tokens.
   *
   * A plugin that declares the domain wins (`companyDomains`, Spec 5086);
   * otherwise the token is derived from the domain (Spec 5069). Returns both
   * the resolved set and the list of domains that did not map to a registered
   * Site token; callers decide whether to fail or to surface them as diagnostics (Spec 5095).
   */
  private resolveCompanyDomains(domains: string[] | undefined): {
    resolved: Set<Site>;
    unresolved: string[];
  } {
    const resolved = new Set<Site>();
    if (!domains?.length) {
      return { resolved, unresolved: [] };
    }

    const unresolved: string[] = [];
    for (const raw of domains) {
      const trimmed = raw?.trim();
      if (!trimmed) {
        continue;
      }
      const site = this.registry.siteForDomain(trimmed) ?? siteFromDomain(trimmed);
      if (site) {
        resolved.add(site);
      } else {
        unresolved.push(trimmed);
      }
    }

    return { resolved, unresolved };
  }

  /**
   * Builds the effective list of sites from explicit `siteType` values and
   * resolved `companyDomain` values, deduplicated while preserving order.
   */
  private buildEffectiveSites(
    explicitSites: Site[] | undefined,
    resolvedSites: Set<Site>,
  ): Site[] {
    const effective = new Set<Site>();
    if (explicitSites?.length) {
      for (const site of explicitSites) {
        effective.add(site);
      }
    }
    for (const site of resolvedSites) {
      effective.add(site);
    }
    return Array.from(effective);
  }

  /**
   * Post-processes a single job's salary data.
   * If the scraper provided direct compensation, optionally convert to annual.
   * If no compensation was returned and the country is USA, try to parse salary from the description.
   * This mirrors the orchestrator logic for salary post-processing.
   */
  private postProcessSalary(job: JobPostDto, input: ScraperInputDto): void {
    const enforceAnnual = input.enforceAnnualSalary ?? false;
    const country = input.country ?? Country.USA;

    if (job.compensation) {
      // Direct compensation from scraper
      job.salarySource = SalarySource.DIRECT_DATA;

      if (
        enforceAnnual &&
        job.compensation.interval &&
        job.compensation.interval !== 'yearly' &&
        job.compensation.minAmount != null &&
        job.compensation.maxAmount != null
      ) {
        const data = {
          interval: job.compensation.interval,
          minAmount: job.compensation.minAmount,
          maxAmount: job.compensation.maxAmount,
        };
        convertToAnnual(data);
        job.compensation.interval = data.interval as any;
        job.compensation.minAmount = data.minAmount;
        job.compensation.maxAmount = data.maxAmount;
      }
    } else if (country === Country.USA && job.description) {
      // Fallback: extract salary from description text (USA only)
      const extracted = extractSalary(job.description, {
        enforceAnnualSalary: enforceAnnual,
      });
      if (extracted.minAmount != null) {
        job.salarySource = SalarySource.DESCRIPTION;
        job.compensation = new CompensationDto({
          interval: extracted.interval as any,
          minAmount: extracted.minAmount,
          maxAmount: extracted.maxAmount,
          currency: extracted.currency ?? 'USD',
        });
      }
    }

    // Clear salary source if no salary data
    if (!job.compensation?.minAmount) {
      job.salarySource = undefined;
    }
  }

  /**
   * Dynamically register a new scraper (used by community plugins)
   */
  registerScraper(site: string, scraper: IScraper) {
    this.registry.registerExternal(site, scraper);
  }

  /**
   * List all currently registered source keys
   */
  listRegisteredSources(): string[] {
    return this.registry.listSiteKeys();
  }
}
