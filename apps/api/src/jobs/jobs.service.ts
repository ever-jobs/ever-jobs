import { OnModuleInit, Injectable, Logger, Optional, BadRequestException } from '@nestjs/common';
import {
  Site, ScraperInputDto, JobPostDto, JobResponseDto, IScraper,
  Country,
  ERR_SOURCE_CIRCUIT_OPEN,
  SourceDiagnosticDto, ScrapeReason, ScrapeDiagnostics, classifyScrapeError,
} from '@ever-jobs/models';
import {
  postProcessCompensation, postedSortKey, siteFromDomain, deriveSiteToken, resolveCompanyUrl,
  resolveSearchLocations, clampMaxLocations, runWithHttpMemo, httpMemoMethodsFromEnv,
} from '@ever-jobs/common';
import { ConfigService } from '@nestjs/config';
import { PluginRegistry, CircuitBreakerInterceptor } from '@ever-jobs/plugin';
import { MetricsService } from '../metrics/metrics.service';

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

// ── Multi-location search (Spec 1700) ────────────────────────────────

/**
 * Env var for the number of `locations` entries actually searched (Spec 1700).
 * Clamped into `[1, HARD_MAX_SEARCH_LOCATIONS]` by `clampMaxLocations`; a bad
 * value falls back to `DEFAULT_MAX_SEARCH_LOCATIONS` (10). Read through
 * `search.maxLocations` first, so a config-file key wins when one is added.
 */
export const SEARCH_MAX_LOCATIONS_ENV = 'EVER_JOBS_SEARCH_MAX_LOCATIONS';

/**
 * Env var for the pause between two consecutive location calls to the SAME
 * source in a multi-location search, milliseconds (Spec 1700). `0` disables.
 */
export const SEARCH_LOCATION_INTERVAL_ENV = 'EVER_JOBS_SEARCH_LOCATION_INTERVAL_MS';

/**
 * Default pause between one source's location calls (Spec 1700).
 *
 * Most company and ATS plugins fetch their whole board and filter by location
 * locally, so N locations fetch the same board N times. The calls are already
 * sequential per source; this spaces them so a board never sees a burst from
 * one search. Sources still run in parallel with each other.
 */
export const DEFAULT_SEARCH_LOCATION_INTERVAL_MS = 500;

/** Upper bound accepted for the location interval (Spec 1700). */
export const MAX_SEARCH_LOCATION_INTERVAL_MS = 10_000;

/**
 * Upper bound honoured for a plugin's declared
 * `IPluginMetadata.minRequestIntervalMs` (Spec 1700), so a typo in one
 * plugin cannot stall a search.
 */
export const MAX_PLUGIN_REQUEST_INTERVAL_MS = 30_000;

/**
 * The pause between two location calls to one source: the operator's
 * interval, raised to the gap the plugin itself keeps between requests
 * (LinkedIn 3-7 s, Glassdoor 5 s, ...). A declared gap applies even when the
 * operator set the interval to 0, because it is the plugin's own contract
 * with its host.
 */
export function locationPauseMs(intervalMs: number, declaredMs: unknown): number {
  const declared =
    typeof declaredMs === 'number' && Number.isFinite(declaredMs) && declaredMs > 0
      ? Math.min(Math.floor(declaredMs), MAX_PLUGIN_REQUEST_INTERVAL_MS)
      : 0;
  return Math.max(intervalMs, declared);
}

/** Minimal config seam shared by the service, the controller and the resolver. */
export interface SearchConfigReader {
  get(key: string): unknown;
}

/** The `locations` cap in force (Spec 1700). */
export function readMaxSearchLocations(config: SearchConfigReader): number {
  return clampMaxLocations(config.get('search.maxLocations') ?? config.get(SEARCH_MAX_LOCATIONS_ENV));
}

/**
 * Normalise a configured location interval into
 * `[0, MAX_SEARCH_LOCATION_INTERVAL_MS]`; anything unparsable or out of range
 * resolves to {@link DEFAULT_SEARCH_LOCATION_INTERVAL_MS}.
 */
export function clampLocationInterval(raw: unknown): number {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_SEARCH_LOCATION_INTERVAL_MS;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > MAX_SEARCH_LOCATION_INTERVAL_MS) {
    return DEFAULT_SEARCH_LOCATION_INTERVAL_MS;
  }
  return Math.floor(n);
}

/**
 * A per-source diagnostic row for one (source, location) pair of a
 * multi-location search (Spec 1700). `site` stays the bare site key, so
 * consumers that group by `site` keep working.
 */
export class LocatedSourceDiagnosticDto extends SourceDiagnosticDto {
  location: string;

  constructor(site: string, count: number, reason: ScrapeReason, detail: string | undefined, location: string) {
    super(site, count, reason, detail);
    this.location = location;
  }
}

/** Why the rest of a source's locations were not attempted. */
interface LocationRefusal {
  readonly reason: ScrapeReason;
  /** The location whose call showed the refusal. */
  readonly trigger: string;
}

/** What happened to one (source, location) call. */
interface LocationOutcome {
  readonly location: string;
  readonly settled?: PromiseSettledResult<JobResponseDto>;
  /** Set when the call was not made because the source already refused us. */
  readonly notAttempted?: LocationRefusal;
  /** Set when the call was not made because the search deadline had passed. */
  readonly deadlineSkipped?: boolean;
}

const RATE_LIMIT_TEXT = /\b429\b|too many requests|rate[ -]?limit/i;

/**
 * Did this thrown error show the source refusing us (Spec 1700)? A 429, an
 * open circuit breaker, or anything `classifyScrapeError` calls `blocked`
 * (401/403/407, captcha, challenge). Timeouts, 5xx and 404s are not refusals:
 * the next location may well succeed.
 */
function refusalFromError(err: unknown): ScrapeReason | undefined {
  const e = err as { code?: unknown; response?: { status?: unknown } } | null | undefined;
  if (e?.code === ERR_SOURCE_CIRCUIT_OPEN) return 'circuit_open';
  if (e?.response?.status === 429) return 'fetch_error';
  const diag = classifyScrapeError(err);
  if (diag.reason === 'blocked') return 'blocked';
  if (diag.reason === 'fetch_error' && RATE_LIMIT_TEXT.test(diag.detail ?? '')) return 'fetch_error';
  return undefined;
}

/**
 * The same test for a plugin that swallowed its error and resolved with a
 * diagnostic instead.
 */
function refusalFromDiagnostics(diag: ScrapeDiagnostics | undefined): ScrapeReason | undefined {
  if (!diag) return undefined;
  if (diag.reason === 'blocked' || diag.reason === 'circuit_open') return diag.reason;
  if (diag.reason === 'fetch_error' && RATE_LIMIT_TEXT.test(diag.detail ?? '')) return 'fetch_error';
  return undefined;
}

/**
 * Identity of a posting within one source, for removing the duplicates the
 * location fan-out itself creates (the same posting returned for two
 * locations). Scoped by site — the same id from two sources is the dedup
 * engine's call, not ours — and built from BOTH `id` and `jobUrl`: some
 * plugins derive `id` from the row index, so an id-only key would collapse
 * two different postings that happen to share a position. A job with neither
 * is kept, since we cannot prove it is a duplicate.
 */
function fanoutIdentity(site: string, job: JobPostDto): string | undefined {
  const id = typeof job.id === 'string' && job.id ? job.id : '';
  const url = typeof job.jobUrl === 'string' && job.jobUrl ? job.jobUrl : '';
  if (!id && !url) return undefined;
  return `${site}\u0000${id}\u0000${url}`;
}

/**
 * Per-source outcome row for one settled scrape (Spec 5082). The reason comes
 * from the plugin's own diagnostics when it set them (e.g.
 * `browser_unavailable`, `blocked`); otherwise it is inferred from the settled
 * outcome: jobs → `ok`, empty → `empty`, thrown → classify.
 */
function settledDiagnostic(
  site: string,
  result: PromiseSettledResult<JobResponseDto> | undefined,
): { count: number; reason: ScrapeReason; detail?: string } {
  if (result?.status === 'fulfilled') {
    const jobs = result.value.jobs;
    const diag = result.value.diagnostics;
    // A source that returned jobs AND reported a diagnostic is `partial`:
    // it got some of the board before something failed. Calling that `ok`
    // hid a partial outage behind a non-zero count, and left an `ok` row
    // carrying an error string in `detail`.
    const reason: ScrapeReason =
      jobs.length > 0 ? (diag ? 'partial' : 'ok') : (diag?.reason ?? 'empty');
    return { count: jobs.length, reason, detail: diag?.detail };
  }
  // "We deliberately stopped calling this source" is its own operational
  // state, not an unclassifiable error — the breaker is already tracked
  // for metrics and logs, so don't collapse it to `unknown` here.
  const err = result?.reason as { code?: unknown } | undefined;
  const diag =
    err?.code === ERR_SOURCE_CIRCUIT_OPEN
      ? new ScrapeDiagnostics('circuit_open', `circuit open for ${site}`)
      : classifyScrapeError(result?.reason);
  return { count: 0, reason: diag.reason, detail: diag.detail };
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
   *
   * Multi-location (Spec 1700): when `input.locations` resolves to two or more
   * locations, every selected source is called once per location, one location
   * after another (sources still run in parallel), each call with the caller's
   * own `offset` and `resultsWanted`. The rows become one
   * {@link LocatedSourceDiagnosticDto} per (source, location). With `locations`
   * absent nothing here changes.
   */
  async searchJobsWithDiagnostics(
    input: ScraperInputDto,
  ): Promise<{ jobs: JobPostDto[]; perSource: SourceDiagnosticDto[] }> {
    const plan = this.planLocations(input);
    input = plan.input;
    const searchLocations = plan.locations;
    const multi = searchLocations.length > 1;

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

    const intervalMs = multi
      ? clampLocationInterval(
          this.configService.get('search.locationIntervalMs') ??
            this.configService.get(SEARCH_LOCATION_INTERVAL_ENV),
        )
      : 0;

    this.logger.log(
      `Running ${selectedScrapers.length} scrapers (concurrency ${concurrency}, ` +
        `deadline ${deadlineMs > 0 ? `${deadlineMs}ms` : 'none'}` +
        (multi ? `, ${searchLocations.length} locations each, ${intervalMs}ms apart` : '') +
        `): ${selectedScrapers.map((s) => s.site).join(', ')}`,
    );

    const results: PromiseSettledResult<JobResponseDto>[] = new Array(
      selectedScrapers.length,
    );
    // Spec 1700 — multi-location mode: one entry per site, one outcome per
    // location, in caller location order.
    const locationOutcomes: LocationOutcome[][] = multi
      ? new Array(selectedScrapers.length)
      : [];
    let cursor = 0;
    let skipped = 0;

    // Shared-cursor worker pool — same shape as
    // `LivenessHttpService.checkBatch` (Spec 721), which is the established
    // in-repo pattern for bounded fan-out.
    const worker = async (): Promise<void> => {
      for (;;) {
        const index = cursor++;
        if (index >= selectedScrapers.length) return;

        const { site, scraper } = selectedScrapers[index];

        // Spec 1700 — the unit of work is still one site; its locations run
        // sequentially inside it, so one search never opens concurrent
        // conversations with one source. The loop applies the same deadline
        // rule per location and never throws.
        if (multi) {
          const outcomes = await this.scrapeSiteAcrossLocations(
            site,
            scraper,
            input,
            searchLocations,
            deadlineAt,
            intervalMs,
          );
          skipped += outcomes.filter((o) => o.deadlineSkipped).length;
          locationOutcomes[index] = outcomes;
          continue;
        }

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
      }
    };

    await Promise.allSettled(
      Array.from({ length: Math.min(concurrency, selectedScrapers.length) }, () =>
        worker(),
      ),
    );

    if (skipped > 0) {
      this.logger.warn(
        multi
          ? `Search deadline (${deadlineMs}ms) exceeded — skipped ${skipped} of ` +
              `${selectedScrapers.length * searchLocations.length} (source, location) calls. ` +
              `Raise EVER_JOBS_SEARCH_DEADLINE_MS, or narrow siteType or locations.`
          : `Search deadline (${deadlineMs}ms) exceeded — skipped ${skipped} of ` +
              `${selectedScrapers.length} sources. Raise EVER_JOBS_SEARCH_DEADLINE_MS ` +
              `or narrow siteType to cover more of the catalogue.`,
      );
    }
    // Aggregate results from fulfilled searches + derive a per-source outcome
    // (Spec 5082) — see `settledDiagnostic` for how the reason is chosen.
    const allJobs: JobPostDto[] = [];
    const perSource: SourceDiagnosticDto[] = [];
    if (multi) {
      this.mergeLocationOutcomes(selectedScrapers, locationOutcomes, searchLocations.length, allJobs, perSource);
    } else {
      results.forEach((result, index) => {
        const site = selectedScrapers[index]?.site ?? 'unknown';
        if (result?.status === 'fulfilled') {
          allJobs.push(...result.value.jobs);
        }
        const row = settledDiagnostic(site, result);
        perSource.push(new SourceDiagnosticDto(site, row.count, row.reason, row.detail));
      });
    }

    // Post-processing: salary enrichment (mirrors Python __init__.py logic)
    for (const job of allJobs) {
      this.postProcessSalary(job, input);
    }

    // Sort by site name then by posted time (most recent first). Spec 1696:
    // `postedSortKey` orders by `datePostedAt` when a source gives an instant,
    // else by `datePosted` (start of its day); an unparseable date sorts last
    // instead of making the comparator return NaN.
    allJobs.sort((a, b) => {
      const siteCompare = (a.site ?? '').localeCompare(b.site ?? '');
      if (siteCompare !== 0) return siteCompare;

      return postedSortKey(b) - postedSortKey(a);
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

    // Spec 1700 — locations dropped by the cap are reported, not silently
    // ignored, in the same shape as the `companyDomain:` rows above.
    for (const location of plan.overCap) {
      perSource.push(
        new SourceDiagnosticDto(
          `location:${location}`,
          0,
          'bad_input',
          `dropped: over the ${plan.maxLocations}-location cap`,
        ),
      );
    }

    this.logger.log(`Total aggregated jobs: ${allJobs.length}`);
    return { jobs: allJobs, perSource };
  }

  /**
   * Resolve the locations a search runs (Spec 1700).
   *
   * - `locations` absent → the input is returned untouched (the legacy path:
   *   same object, same plugin input, same cache key).
   * - `locations` present and resolving to 0 or 1 location → collapses to the
   *   single-location path with `location` set to that entry (or left as the
   *   caller sent it) and `locations` removed, so plugins never see a list.
   * - 2 or more → multi-location mode; the per-location clones are built in
   *   {@link scrapeSiteAcrossLocations}.
   */
  private planLocations(input: ScraperInputDto): {
    input: ScraperInputDto;
    locations: string[];
    overCap: string[];
    maxLocations: number;
  } {
    if (input.locations === undefined || input.locations === null) {
      return { input, locations: [], overCap: [], maxLocations: 0 };
    }
    const maxLocations = readMaxSearchLocations(this.configService);
    const { locations, overCap } = resolveSearchLocations(input, maxLocations);
    if (locations.length > 1) {
      return { input, locations, overCap, maxLocations };
    }
    return {
      input: new ScraperInputDto({
        ...input,
        location: locations[0] ?? input.location,
        locations: undefined,
      }),
      locations: [],
      overCap,
      maxLocations,
    };
  }

  /**
   * Run one site across every location, one after another (Spec 1700).
   *
   * - Each call gets a fresh clone of the caller's input with `location` set
   *   and `locations` removed; `offset` and `resultsWanted` are the caller's,
   *   never advanced by an earlier location.
   * - A failing location does not affect the others.
   * - Once a call shows the source refusing us (429, blocked, circuit open),
   *   the remaining locations are NOT attempted — continuing would hammer a
   *   host that has already said stop.
   * - The search deadline is checked before every location and raced during
   *   each call, exactly like the single-location pool.
   * - Consecutive attempted calls are {@link locationPauseMs} apart: the
   *   operator's `intervalMs`, raised to the plugin's declared
   *   `minRequestIntervalMs`.
   * - The whole loop runs in one scoped response memo (`runWithHttpMemo`,
   *   T13): a plugin that fetches its whole board and filters locally sends
   *   the same request for every location, and every repeat is answered from
   *   the memo, so N locations cost one board fetch. A plugin that sends the
   *   location to its host builds a different request per location and still
   *   gets one real request each. `EVER_JOBS_SEARCH_LOCATION_MEMO=off` turns
   *   the memo off (every location fetches again, as before).
   *
   * Never throws.
   */
  private async scrapeSiteAcrossLocations(
    site: Site,
    scraper: IScraper,
    input: ScraperInputDto,
    locations: readonly string[],
    deadlineAt: number,
    intervalMs: number,
  ): Promise<LocationOutcome[]> {
    // Optional call: test doubles of the registry often omit getMetadata.
    const pauseMs = locationPauseMs(intervalMs, this.registry.getMetadata?.(site)?.minRequestIntervalMs);
    const { result, stats } = await runWithHttpMemo(
      () => this.runLocationLoop(site, scraper, input, locations, deadlineAt, pauseMs),
      { methods: httpMemoMethodsFromEnv() },
    );
    if (stats.hits > 0) {
      this.logger.log(
        `${site}: ${locations.length} locations, ${stats.misses} requests sent, ` +
          `${stats.hits} answered from the search's response memo`,
      );
    }
    return result;
  }

  /** The body of {@link scrapeSiteAcrossLocations}, inside its memo scope. */
  private async runLocationLoop(
    site: Site,
    scraper: IScraper,
    input: ScraperInputDto,
    locations: readonly string[],
    deadlineAt: number,
    intervalMs: number,
  ): Promise<LocationOutcome[]> {
    const out: LocationOutcome[] = [];
    let refusal: LocationRefusal | undefined;
    let attempted = false;
    for (const location of locations) {
      if (refusal) {
        this.metrics.scraperRequestsTotal.inc({ site, status: 'location_skipped' });
        out.push({ location, notAttempted: refusal });
        continue;
      }
      if (attempted && intervalMs > 0 && Date.now() < deadlineAt) {
        await this.pause(Math.min(intervalMs, deadlineAt - Date.now()));
      }
      if (Date.now() >= deadlineAt) {
        this.metrics.scraperRequestsTotal.inc({ site, status: 'deadline_skipped' });
        out.push({
          location,
          deadlineSkipped: true,
          settled: {
            status: 'rejected',
            reason: new Error(`${site}: skipped (search deadline exceeded)`),
          },
        });
        continue;
      }
      attempted = true;
      const perLocation = new ScraperInputDto({ ...input, location, locations: undefined });
      try {
        const value = await withDeadline(
          this.scrapeOne(site, scraper, perLocation),
          deadlineAt,
          site,
        );
        out.push({ location, settled: { status: 'fulfilled', value } });
        const reason = refusalFromDiagnostics(value.diagnostics);
        if (reason) refusal = { reason, trigger: location };
      } catch (err) {
        out.push({ location, settled: { status: 'rejected', reason: err } });
        const reason = refusalFromError(err);
        if (reason) refusal = { reason, trigger: location };
      }
      if (refusal) {
        this.logger.warn(
          `${site}: refused the search for "${location}" (${refusal.reason}); ` +
            `not asking it for the remaining locations`,
        );
      }
    }
    return out;
  }

  /**
   * Merge multi-location outcomes (Spec 1700): one diagnostic row per
   * (site, location), and the jobs with the duplicates the fan-out itself
   * created removed — the same posting from the same source under two
   * locations. The first occurrence wins, in caller location order. This runs
   * before, and independently of, the cross-source dedup engine, so it also
   * applies to `?dedup=false` callers.
   */
  private mergeLocationOutcomes(
    selected: ReadonlyArray<{ site: Site }>,
    outcomes: ReadonlyArray<LocationOutcome[] | undefined>,
    locationCount: number,
    allJobs: JobPostDto[],
    perSource: SourceDiagnosticDto[],
  ): void {
    const seen = new Set<string>();
    let raw = 0;
    let duplicates = 0;
    selected.forEach(({ site }, index) => {
      for (const outcome of outcomes[index] ?? []) {
        if (outcome.notAttempted) {
          perSource.push(
            new LocatedSourceDiagnosticDto(
              site,
              0,
              outcome.notAttempted.reason,
              `not attempted: ${site} refused the search for "${outcome.notAttempted.trigger}"`,
              outcome.location,
            ),
          );
          continue;
        }
        const settled = outcome.settled;
        if (settled?.status === 'fulfilled') {
          for (const job of settled.value.jobs) {
            raw++;
            const key = fanoutIdentity(site, job);
            if (key !== undefined) {
              if (seen.has(key)) {
                duplicates++;
                continue;
              }
              seen.add(key);
            }
            allJobs.push(job);
          }
        }
        const row = settledDiagnostic(site, settled);
        perSource.push(
          new LocatedSourceDiagnosticDto(site, row.count, row.reason, row.detail, outcome.location),
        );
      }
    });
    this.logger.log(
      `multi-location: ${selected.length} sites × ${locationCount} locations → ` +
        `${raw} raw, ${duplicates} same-source duplicates removed`,
    );
  }

  /** Politeness pause between one source's location calls. */
  private pause(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
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
   *
   * Spec 1695: the rule lives in `postProcessCompensation` (pure; the
   * scraper's compensation object is never mutated). Setting
   * `EVER_JOBS_SALARY_GRAMMAR=legacy` restores the pre-1695 rules exactly.
   */
  private postProcessSalary(job: JobPostDto, input: ScraperInputDto): void {
    const { compensation, salarySource } = postProcessCompensation({
      compensation: job.compensation,
      description: job.description,
      country: input.country ?? Country.USA,
      enforceAnnualSalary: input.enforceAnnualSalary ?? false,
    });
    job.compensation = compensation;
    job.salarySource = salarySource;
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
