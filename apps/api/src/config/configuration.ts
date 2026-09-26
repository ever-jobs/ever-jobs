import {
  resolveCacheMaxJobs,
  resolveFanoutDeadlineMs,
  resolveLivenessConfig,
  resolveResultCaps,
} from './search-config';
import { resolvePersistSearch } from './store-config';
import { readCrawlPolicyEnv, resolveCrawlPolicy } from '@ever-jobs/common';
import { CircuitBreakerService } from '@ever-jobs/plugin';

/**
 * Central configuration factory.
 * Maps every environment variable to a typed config object.
 */
export default () => {
  const parseBool = (val: string | undefined, fallback: boolean): boolean => {
    if (val === undefined || val === '') return fallback;
    return ['true', '1', 'yes', 'on'].includes(val.toLowerCase());
  };

  const parseList = (val: string | undefined): string[] => {
    if (!val || val.trim() === '') return [];
    return val.split(',').map((s) => s.trim()).filter(Boolean);
  };

  const parseInt = (val: string | undefined, fallback: number): number => {
    if (val === undefined || val === '') return fallback;
    const n = Number(val);
    return Number.isNaN(n) ? fallback : n;
  };

  return {
    port: parseInt(process.env.PORT, 3001),

    // API Security
    auth: {
      enabled: parseBool(process.env.ENABLE_API_KEY_AUTH, false),
      apiKeys: parseList(process.env.API_KEYS),
      headerName: process.env.API_KEY_HEADER_NAME || 'x-api-key',
    },

    // Rate Limiting
    rateLimit: {
      enabled: parseBool(process.env.RATE_LIMIT_ENABLED, false),
      maxRequests: parseInt(process.env.RATE_LIMIT_REQUESTS, 100),
      timeframeSec: parseInt(process.env.RATE_LIMIT_TIMEFRAME, 3600),
    },

    // Proxy
    proxy: {
      defaults: parseList(process.env.DEFAULT_PROXIES),
      caCertPath: process.env.CA_CERT_PATH || null,
    },

    // Search Defaults
    defaults: {
      siteNames: parseList(
        process.env.DEFAULT_SITE_NAMES ||
          'linkedin,indeed,zip_recruiter,glassdoor,google,bayt,naukri,bdjobs,internshala,exa,upwork',
      ),
      resultsWanted: parseInt(process.env.DEFAULT_RESULTS_WANTED, 20),
      distance: parseInt(process.env.DEFAULT_DISTANCE, 50),
      descriptionFormat: process.env.DEFAULT_DESCRIPTION_FORMAT || 'markdown',
      country: process.env.DEFAULT_COUNTRY || 'USA',
    },

    // Caching
    cache: {
      enabled: parseBool(process.env.ENABLE_CACHE, false),
      expirySec: parseInt(process.env.CACHE_EXPIRY, 3600),
      redisUrl: process.env.REDIS_URL || null,
      maxItems: parseInt(process.env.CACHE_MAX_ITEMS, 500),
      /**
       * Spec 1720 / FR-13 — `EVER_JOBS_CACHE_MAX_JOBS` (default 5000): a raw
       * fan-out larger than this is served but not cached; `0` never caches.
       */
      maxJobs: resolveCacheMaxJobs(process.env),
    },

    // Search fan-out bounds (Spec 5026)
    search: {
      /**
       * Max sources dispatched simultaneously by `JobsService.searchJobs`.
       * Peak memory is O(concurrency), not O(selected sources).
       */
      concurrency: parseInt(process.env.EVER_JOBS_SEARCH_CONCURRENCY, 64),
      /**
       * Wall-clock budget for one fan-out, ms. Once exceeded, no further
       * sources are STARTED (in-flight ones finish). `0` disables.
       * Defaults to the Hust client's own 120 s abort.
       * Spec 1721: `EVER_JOBS_FANOUT_DEADLINE_MS`, falling back to
       * `EVER_JOBS_SEARCH_DEADLINE_MS`.
       */
      deadlineMs: resolveFanoutDeadlineMs(process.env),
      /**
       * Spec 1720 / FR-12 — `EVER_JOBS_MAX_RESULTS_WANTED` (default 1000)
       * clamps `resultsWanted` per source; `EVER_JOBS_MAX_JOBS_PER_SEARCH`
       * (default 40000 since FR-13) stops starting sources once that many raw
       * jobs are in. `0` disables either.
       */
      ...resolveResultCaps(process.env),
    },
    // Liveness server gate + per-request cap (Spec 1723)
    liveness: resolveLivenessConfig(process.env),
    // Persistence (Spec 5024 — bounded retention on the interactive path)
    store: {
      /**
       * Persist the post-dedup canonical corpus on every `/api/jobs/search`
       * (and the GraphQL equivalent). Spec 1722: an explicit
       * `EVER_JOBS_PERSIST_SEARCH` always wins; unset, it is `false` for the
       * `memory` backend (a pure heap sink nothing reads back) and `true`
       * when a durable backend is explicitly selected via `EVER_JOBS_STORE`
       * (`sqlite` / `postgres`).
       */
      persistSearch: resolvePersistSearch(process.env),
      /**
       * Hard ceiling on rows retained by an in-process store backend.
       * Bounds RSS regardless of {@link persistSearch}; see
       * `packages/plugins/store-memory`.
       */
      maxRows: parseInt(process.env.EVER_JOBS_STORE_MAX_ROWS, 50_000),
    },

    // Retry policies
    retry: {
      defaultRetries: parseInt(process.env.RETRY_DEFAULT_RETRIES, 3),
      defaultDelayMs: parseInt(process.env.RETRY_DEFAULT_DELAY_MS, 1000),
      defaultBackoff: process.env.RETRY_DEFAULT_BACKOFF || 'linear',
      perSource: (() => {
        try {
          return JSON.parse(process.env.RETRY_PER_SOURCE || '{}');
        } catch {
          return {};
        }
      })(),
    },

    // Crawl policy (Spec 1690) — a READ-ONLY mirror, snapshotted at boot, so the
    // effective settings are visible next to the rest of the config. The
    // authority is `readCrawlPolicyEnv()` in @ever-jobs/common, which
    // HttpClient / BrowserPool / JobsService read directly (plugins build their
    // HTTP clients without DI, so they cannot use ConfigService). Changing a
    // value here changes nothing; set the EVER_JOBS_CRAWL_* variables.
    crawl: (() => {
      const env = readCrawlPolicyEnv();
      return {
        preset: env.preset,
        callerOverrides: env.callerOverrides,
        abortOnDeadline: env.abortOnDeadline,
        /** EVER_JOBS_CRAWL_* (and explicitly set RETRY_DEFAULT_*) overrides. */
        global: env.global,
        /** Operator per-site / per-host policies (EVER_JOBS_CRAWL_POLICIES / _POLICY_FILE / RETRY_PER_SOURCE). */
        policies: env.policies,
        /** Count only — proxy URLs may carry credentials. */
        proxyCount: env.proxies.length,
        warnings: env.warnings,
        /** The policy a request gets before plugin, host and caller layers apply. */
        effective: resolveCrawlPolicy({}, env),
      };
    })(),

    // Circuit breaker (Spec 005; cap configurable since Spec 1690) — mirror.
    circuit: {
      maxSites: CircuitBreakerService.readMaxSites(process.env),
    },

    // GraphQL
    graphql: {
      enabled: parseBool(process.env.ENABLE_GRAPHQL, true),
      playground: parseBool(process.env.GRAPHQL_PLAYGROUND, true),
      path: process.env.GRAPHQL_PATH || 'graphql',
    },

    // Prometheus Metrics
    metrics: {
      enabled: parseBool(process.env.ENABLE_METRICS, true),
    },

    // Plugins
    plugins: {
      enabled: parseBool(process.env.ENABLE_PLUGINS, false),
      dir: process.env.PLUGINS_DIR || null,
    },

    // Career level (Spec 1730, contract C7)
    careerLevel: {
      /**
       * Attach `careerLevel` ({ level, confidence, reasons }) to every job the search returns,
       * computed in-process after dedup. Default `true`; `false` removes the field from every
       * response. An explicit `careerLevels` request filter is still honoured when `false`.
       */
      classify: parseBool(process.env.EVER_JOBS_CLASSIFY_CAREER_LEVEL, true),
    },

    // Logging
    logLevel: process.env.LOG_LEVEL || 'info',
    environment: process.env.NODE_ENV || 'development',

    // CORS
    cors: {
      origins: parseList(process.env.CORS_ORIGINS || '*'),
    },

    // Swagger
    swagger: {
      enabled: parseBool(process.env.ENABLE_SWAGGER, true),
      path: process.env.SWAGGER_PATH || 'swg',
    },

    // Scalar
    scalar: {
      enabled: parseBool(process.env.ENABLE_SCALAR, true),
      path: process.env.SCALAR_PATH || 'docs',
    },
  };
};
