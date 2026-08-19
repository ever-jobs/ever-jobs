import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from 'prom-client';
import { CircuitState, SourceHealth } from '@ever-jobs/models';

/**
 * Numeric encoding for {@link MetricsService.sourceCircuitState} —
 * `closed=0, half-open=1, open=2`. Severity ascending so a single PromQL
 * predicate (`source_circuit_state >= 2`) matches "open episode in
 * progress" without having to remember bespoke per-state booleans.
 *
 * Spec 005 / T06 / Q-015 — encoding documented in the Gauge's HELP text
 * and consumed by `metrics-circuit-breaker.bridge.ts`.
 */
export const CIRCUIT_STATE_GAUGE_VALUE: Record<CircuitState, number> = {
  closed: 0,
  'half-open': 1,
  open: 2,
};

/**
 * Provider closure that returns the latest per-site health snapshots.
 * Wired through {@link MetricsService.bindCircuitBreakerSource} by
 * `apps/api/src/jobs/metrics-circuit-breaker.bridge.ts`.
 */
export type CircuitBreakerHealthSource = () => SourceHealth[];

@Injectable()
export class MetricsService implements OnModuleInit {
  private readonly logger = new Logger(MetricsService.name);
  private readonly registry: Registry;

  // HTTP Request metrics
  public readonly httpRequestsTotal: Counter;
  public readonly httpRequestDuration: Histogram;

  // Scraper metrics
  public readonly scraperRequestsTotal: Counter;
  public readonly scraperDuration: Histogram;

  // Cache metrics
  public readonly cacheHitsTotal: Counter;
  public readonly cacheMissesTotal: Counter;

  // System metrics
  public readonly totalSources: Gauge;

  /**
   * Spec 005 / T06 — per-site circuit-breaker state Gauge. Values come
   * from {@link CIRCUIT_STATE_GAUGE_VALUE}. The Gauge's `collect`
   * callback delegates to `circuitBreakerSource` (set via
   * {@link bindCircuitBreakerSource}); when no source is bound the
   * Gauge produces no samples and `source_circuit_state` is simply
   * absent from `/metrics` (back-compat with test bootstraps that don't
   * import `JobsModule`).
   */
  public readonly sourceCircuitState: Gauge;

  /**
   * Closure that returns the live `SourceHealth[]` snapshot. `undefined`
   * until {@link bindCircuitBreakerSource} is called (typically from
   * `MetricsCircuitBreakerBridge` at application bootstrap).
   */
  private circuitBreakerSource?: CircuitBreakerHealthSource;

  constructor() {
    this.registry = new Registry();

    // Default metrics (CPU, Memory, Event Loop)
    collectDefaultMetrics({ register: this.registry, prefix: 'ever_jobs_' });

    // HTTP Metrics
    this.httpRequestsTotal = new Counter({
      name: 'ever_jobs_http_requests_total',
      help: 'Total number of HTTP requests',
      labelNames: ['method', 'path', 'status_code'],
      registers: [this.registry],
    });

    this.httpRequestDuration = new Histogram({
      name: 'ever_jobs_http_request_duration_seconds',
      help: 'HTTP request duration in seconds',
      labelNames: ['method', 'path'],
      buckets: [0.1, 0.5, 1, 2, 5, 10],
      registers: [this.registry],
    });

    // Scraper Metrics
    this.scraperRequestsTotal = new Counter({
      name: 'ever_jobs_scraper_requests_total',
      help: 'Total number of scraper requests',
      // `status` is `success` for a clean scrape, `error` for a rejected one and
      // `circuit_open` when the breaker short-circuited. Since Spec 1680 a plugin
      // that resolves WITH a diagnostic also reports its ScrapeReason here -
      // `partial` when it still returned jobs, otherwise the reason itself
      // (`blocked`, `bad_input`, `browser_unavailable`, `fetch_error`, `timeout`,
      // `empty`, `not_registered`, `unknown`). Previously any resolved promise
      // counted as `success`, so a fully-failed scrape was recorded as one.
      labelNames: ['site', 'status'],
      registers: [this.registry],
    });

    this.scraperDuration = new Histogram({
      name: 'ever_jobs_scraper_duration_seconds',
      help: 'Duration of job scraping in seconds',
      labelNames: ['site'],
      buckets: [1, 5, 10, 30, 60],
      registers: [this.registry],
    });

    // Cache Metrics
    this.cacheHitsTotal = new Counter({
      name: 'ever_jobs_cache_hits_total',
      help: 'Total number of cache hits',
      registers: [this.registry],
    });

    this.cacheMissesTotal = new Counter({
      name: 'ever_jobs_cache_misses_total',
      help: 'Total number of cache misses',
      registers: [this.registry],
    });

    // System Metrics
    this.totalSources = new Gauge({
      name: 'ever_jobs_sources_total',
      help: 'Total number of supported job sources',
      registers: [this.registry],
    });

    // Spec 005 / T06 — per-site circuit-breaker state.
    // Encoding: closed=0, half-open=1, open=2 (severity ascending).
    // The `collect` hook is invoked by prom-client on every scrape of
    // `/metrics`, so values are always live; no background tick is
    // needed and the breaker's lazy-init memory property (NFR-3) is
    // preserved (we only ever read what `breaker.list()` already holds).
    this.sourceCircuitState = new Gauge({
      name: 'ever_jobs_source_circuit_state',
      help: 'Per-source circuit-breaker state (closed=0, half-open=1, open=2). Spec 005 / T06.',
      labelNames: ['site'],
      registers: [this.registry],
      collect: () => {
        if (!this.circuitBreakerSource) return;
        let snapshots: SourceHealth[];
        try {
          snapshots = this.circuitBreakerSource();
        } catch (err) {
          // The collect callback runs on every `/metrics` scrape; a
          // throw here would corrupt the entire response. Swallow and
          // log so /metrics stays available even if the breaker itself
          // is misbehaving.
          this.logger.warn(
            `circuitBreakerSource threw during collect: ${(err as Error)?.message ?? err}`,
          );
          return;
        }
        // `reset()` clears any stale labels (e.g. a site that was
        // observed earlier in the process but has since aged out of the
        // breaker's `entries` map — currently impossible, but defensive
        // against a future eviction policy).
        this.sourceCircuitState.reset();
        for (const snap of snapshots) {
          this.sourceCircuitState.set(
            { site: snap.site },
            CIRCUIT_STATE_GAUGE_VALUE[snap.state] ?? 0,
          );
        }
      },
    });
  }

  onModuleInit() {
    // Initial value for total sources
    this.totalSources.set(160);
  }

  /**
   * Wire a live source for {@link sourceCircuitState}. Called by
   * `MetricsCircuitBreakerBridge` from `JobsModule` at application
   * bootstrap. Calling more than once replaces the previous source —
   * acceptable, the bridge is a singleton.
   *
   * Spec 005 / T06 / Q-015 (Option A). When no source is bound the
   * Gauge produces no samples and the metric is absent from `/metrics`.
   */
  bindCircuitBreakerSource(source: CircuitBreakerHealthSource): void {
    this.circuitBreakerSource = source;
    this.logger.log(
      'circuitBreakerSource bound — source_circuit_state will populate on next /metrics scrape',
    );
  }

  async getMetrics(): Promise<string> {
    return this.registry.metrics();
  }

  get contentType(): string {
    return this.registry.contentType;
  }
}
