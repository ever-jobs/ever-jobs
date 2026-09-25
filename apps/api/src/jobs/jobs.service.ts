import { OnModuleInit, Injectable, Logger, Optional, BadRequestException } from '@nestjs/common';
import {
  Site, ScraperInputDto, JobPostDto, JobResponseDto, IScraper,
  Country, SalarySource, CompensationDto,
  ERR_SOURCE_CIRCUIT_OPEN,
  SourceDiagnosticDto, ScrapeReason, ScrapeDiagnostics, classifyScrapeError,
} from '@ever-jobs/models';
import {
  extractSalary, convertToAnnual, siteFromDomain, deriveSiteToken, resolveCompanyUrl,
  runWithScrapeContext, readCrawlPolicyEnv, getEffectiveCrawlPolicy, crawlCallerProxiesAllowed,
  type CrawlPolicyOverride, type PluginCrawlPolicy, type ScrapeContext,
} from '@ever-jobs/common';
import { ConfigService } from '@nestjs/config';
import { PluginRegistry, CircuitBreakerInterceptor, CircuitBreakerService } from '@ever-jobs/plugin';
import { MetricsService } from '../metrics/metrics.service';
import { buildCallerCrawlOverride } from './crawl-policy.mapping';

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
 * `EVER_JOBS_SEARCH_DEADLINE_MS`.
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
 * `code` of the `AbortSignal` reason a scrape receives when the search deadline
 * abandons it (Spec 1690 §4.6). HttpClient/BrowserPool see the signal through
 * the scrape context and cancel queued and in-flight requests.
 */
export const ERR_SCRAPE_DEADLINE_ABORTED = 'ERR_SCRAPE_DEADLINE_ABORTED';

/** Per-dispatch options for {@link JobsService} `scrapeOne` (Spec 1690). */
interface ScrapeOneOptions {
  /**
   * The caller's crawl override, built once per search. When the key is absent
   * it is built from `input` (a direct call); `undefined` means "caller set
   * nothing".
   */
  callerCrawl?: CrawlPolicyOverride;
  /** Aborted when the search deadline abandons this source. */
  signal?: AbortSignal;
}

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
 * The plugin contract has no AbortSignal (see Spec 5026 task T11), so the
 * `scrapeOne` promise itself cannot be cancelled. Since Spec 1690 `onExpire`
 * fires when the deadline abandons the source: `JobsService` uses it to abort
 * the scrape's `AbortController`, which the scrape context hands to every
 * HttpClient/BrowserPool call, so queued and in-flight requests stop instead of
 * running on detached (`EVER_JOBS_CRAWL_ABORT_ON_DEADLINE=false` restores the
 * detached behaviour). Either way this guarantees that the *handler* returns
 * and the response is sent, rather than the request living as long as the
 * slowest hung socket.
 *
 * The timer is always cleared, so a fast source leaves nothing behind.
 */
function withDeadline<T>(
  promise: Promise<T>,
  deadlineAt: number,
  site: Site,
  onExpire?: () => void,
): Promise<T> {
  const remaining = deadlineAt - Date.now();
  if (!Number.isFinite(remaining)) return promise;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      // Reject first so the handler always sees the deadline error, not
      // whatever the aborted scrape rejects with a few microtasks later.
      reject(new Error(`${site}: abandoned (search deadline exceeded mid-flight)`));
      try {
        onExpire?.();
      } catch {
        // An abort hook must never turn a deadline into an uncaught exception.
      }
    }, Math.max(0, remaining));
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
  ): Promise<{ jobs: JobPostDto[]; perSource: SourceDiagnosticDto[] }> {
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

    const selectedScrapers: { site: Site; scraper: IScraper }[] = [];

    for (const site of sites) {
      const scraper = this.registry.getScraper(site);
      if (scraper) {
        selectedScrapers.push({ site, scraper });
      } else {
        this.logger.warn(`Unknown site: ${site}`);
      }
    }

    if (selectedScrapers.length === 0) {
      this.logger.warn('No valid scrapers selected');
      return { jobs: [], perSource: [] };
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
        `deadline ${deadlineMs > 0 ? `${deadlineMs}ms` : 'none'}): ` +
        `${selectedScrapers.map((s) => s.site).join(', ')}`,
    );

    // Spec 1690 §4.1 — the caller's crawl policy (the `crawl` object plus the
    // legacy flat fields the caller actually sent), built and validated once
    // per search. One shared object also lets the policy resolver memoise per
    // caller instead of per source.
    const callerCrawl = this.buildCallerCrawl(input);
    if (input.proxies?.length && this.callerProxies(input) === undefined) {
      this.logger.warn(
        `Search proxies ignored (${input.proxies.length} supplied): EVER_JOBS_CRAWL_CALLER_PROXIES=none ` +
          `(the default unless EVER_JOBS_CRAWL_CALLER_OVERRIDES=any)`,
      );
    }

    const results: PromiseSettledResult<JobResponseDto>[] = new Array(
      selectedScrapers.length,
    );
    let cursor = 0;
    let skipped = 0;
    let aborted = 0;

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
          continue;
        }

        // Spec 1690 §4.6 — one AbortController per scrape. Its signal travels in
        // the scrape context; the deadline aborts it so the abandoned source's
        // queued and in-flight requests stop.
        const controller = new AbortController();
        try {
          // Race against the deadline as well as checking it before starting:
          // a source that never settles would otherwise keep this worker (and
          // therefore the whole handler) pending indefinitely.
          results[index] = {
            status: 'fulfilled',
            value: await withDeadline(
              this.scrapeOne(site, scraper, input, { callerCrawl, signal: controller.signal }),
              deadlineAt,
              site,
              () => {
                if (this.abortAtDeadline(site, controller)) aborted++;
              },
            ),
          };
        } catch (err) {
          results[index] = { status: 'rejected', reason: err };
        }
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
          `${selectedScrapers.length} sources. Raise EVER_JOBS_SEARCH_DEADLINE_MS ` +
          `or narrow siteType to cover more of the catalogue.`,
      );
    }
    if (aborted > 0) {
      this.logger.warn(
        `Search deadline (${deadlineMs}ms) abandoned ${aborted} in-flight source(s); ` +
          `their outstanding requests were aborted (EVER_JOBS_CRAWL_ABORT_ON_DEADLINE=false ` +
          `lets them run on detached).`,
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

    this.logger.log(`Total aggregated jobs: ${allJobs.length}`);
    return { jobs: allJobs, perSource };
  }

  /**
   * Dispatch a single source. Extracted from the fan-out loop by Spec 5026 so
   * the worker pool has a plain unit of work to schedule.
   *
   * Spec 1690 §4.1/§4.6: the scrape runs inside a scrape context carrying the
   * site, the plugin's `@SourcePlugin({ crawl })` defaults, the caller's crawl
   * override, the deadline `AbortSignal` and the caller's proxies — every
   * HttpClient/BrowserPool call the plugin makes reads its policy from there.
   */
  private async scrapeOne(
    site: Site,
    scraper: IScraper,
    input: ScraperInputDto,
    options: ScrapeOneOptions = {},
  ): Promise<JobResponseDto> {
    // Resolve retry policy for this source. Kept for backward compatibility:
    // plugins still receive a DTO with these filled in. Inside the scrape
    // context HttpClient ignores them (the context carries the policy), and
    // these FILLED values never become caller overrides — only what the
    // caller actually sent does (`callerCrawl`, built from `input`).
    const globalRetry = this.configService.get('retry');
    const perSourceRetry = globalRetry.perSource?.[site] || {};

    // Spec 1690 §4.4: a caller's proxies reach every plugin client through the
    // scrape context — unless the operator refuses them
    // (EVER_JOBS_CRAWL_CALLER_PROXIES=none; the default whenever caller
    // overrides are not `any`). Refused proxies reach neither the context nor the
    // DTO a plugin could forward to createHttpClient.
    const proxies = this.callerProxies(input);
    const scraperInput = new ScraperInputDto({
      ...input,
      proxies,
      retries: input.retries ?? perSourceRetry.retries ?? globalRetry.defaultRetries,
      retryDelay: input.retryDelay ?? perSourceRetry.delayMs ?? globalRetry.defaultDelayMs,
      retryBackoff: input.retryBackoff ?? perSourceRetry.backoff ?? globalRetry.defaultBackoff,
      retryMaxDelay: input.retryMaxDelay ?? perSourceRetry.maxDelayMs ?? 30000,
    });

    const signal = options.signal;
    const scrapeContext: ScrapeContext = {
      site,
      plugin: this.pluginCrawlPolicy(site),
      caller: 'callerCrawl' in options ? options.callerCrawl : this.buildCallerCrawl(input),
      signal,
      proxies,
    };
    // Spec 1690 §4.6 — once the deadline aborted this scrape, its failure says
    // nothing about the source's health: mark it circuit-neutral so the
    // breaker counts it neither as a failure nor as a success.
    const dispatch = async (): Promise<JobResponseDto> => {
      try {
        return await runWithScrapeContext(scrapeContext, () => scraper.scrape(scraperInput));
      } catch (err) {
        throw signal?.aborted ? CircuitBreakerService.markNeutral(err) : err;
      }
    };

    this.logger.log(`Starting search for ${site} (${this.describeEffectivePolicy(scrapeContext, scraperInput)})`);
    const scraperStop = this.metrics.scraperDuration.startTimer({ site });
    try {
      // Spec 005 / T04 — wrap the per-source dispatch in the circuit
      // breaker when bound. The interceptor short-circuits with
      // `ERR_SOURCE_CIRCUIT_OPEN` once the breaker has tripped, which
      // we surface as a `circuit_open` metric status (not `error`) so
      // operators can distinguish "source down" from "we stopped
      // calling source" on the dashboard.
      const response = this.circuitBreaker
        ? await this.circuitBreaker.wrap(site, dispatch)
        : await dispatch();
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
      // Spec 1690 §4.6 — we cancelled it at the search deadline; nobody is
      // waiting for this result any more.
      const isDeadlineAbort = !isCircuitOpen && signal?.aborted === true;
      this.metrics.scraperRequestsTotal.inc({
        site,
        status: isCircuitOpen ? 'circuit_open' : isDeadlineAbort ? 'deadline_aborted' : 'error',
      });
      if (isCircuitOpen) {
        // Breaker short-circuits are an *expected* fan-out outcome
        // for a degraded source — log at warn, not error, and keep
        // the message terse so logs stay readable.
        this.logger.warn(`${site}: skipped (circuit open)`);
      } else if (isDeadlineAbort) {
        this.logger.warn(`${site}: aborted at the search deadline (${err?.message ?? err})`);
      } else {
        this.logger.error(`${site} search failed: ${err.message}`);
      }
      throw err;
    }
  }

  /**
   * The caller's crawl override for a search (Spec 1690 §4.1): the `crawl`
   * object plus the legacy flat fields the caller actually sent, validated.
   * Problems are logged once here rather than once per source.
   */
  private buildCallerCrawl(input: ScraperInputDto): CrawlPolicyOverride | undefined {
    const { override, warnings } = buildCallerCrawlOverride(input);
    if (warnings.length > 0) {
      this.logger.warn(`Search crawl policy: ${warnings.join('; ')}`);
    }
    return override;
  }

  /**
   * The caller's `proxies`, when the operator lets callers supply them
   * (`EVER_JOBS_CRAWL_CALLER_PROXIES`, Spec 1690 §4.4); otherwise `undefined`.
   */
  private callerProxies(input: ScraperInputDto): string[] | undefined {
    if (!input.proxies?.length) return input.proxies;
    return crawlCallerProxiesAllowed(readCrawlPolicyEnv()) ? input.proxies : undefined;
  }

  /**
   * The retry/pacing figures this source actually runs under — the crawl policy
   * resolved for the site in its scrape context (Spec 1690), not the DTO values
   * filled in for backward compatibility, which HttpClient ignores inside the
   * context. Falls back to those, labelled, if the policy cannot be resolved.
   */
  private describeEffectivePolicy(scrapeContext: ScrapeContext, scraperInput: ScraperInputDto): string {
    try {
      const policy = runWithScrapeContext(scrapeContext, () => getEffectiveCrawlPolicy());
      return (
        `retries=${policy.retries}, backoff=${policy.retryBackoff}, ` +
        `maxPerHost=${policy.maxConcurrentPerHost}, minIntervalMs=${policy.minIntervalMs}`
      );
    } catch {
      return `DTO retries=${scraperInput.retries}, DTO backoff=${scraperInput.retryBackoff}`;
    }
  }

  /**
   * The plugin's `@SourcePlugin({ crawl })` defaults, if it declares any. The
   * optional call keeps registry stand-ins without `getMetadata` (test stubs)
   * working.
   */
  private pluginCrawlPolicy(site: Site): PluginCrawlPolicy | undefined {
    return this.registry.getMetadata?.(site)?.crawl;
  }

  /**
   * Abort a scrape the search deadline just abandoned (Spec 1690 §4.6), unless
   * `EVER_JOBS_CRAWL_ABORT_ON_DEADLINE=false`. Returns whether it aborted.
   */
  private abortAtDeadline(site: Site, controller: AbortController): boolean {
    if (controller.signal.aborted || !readCrawlPolicyEnv().abortOnDeadline) {
      return false;
    }
    const reason = Object.assign(
      new Error(`${site}: aborted (search deadline exceeded)`),
      { name: 'AbortError', code: ERR_SCRAPE_DEADLINE_ABORTED, site },
    );
    controller.abort(reason);
    this.logger.debug(`${site}: search deadline passed — aborted its outstanding requests`);
    return true;
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
