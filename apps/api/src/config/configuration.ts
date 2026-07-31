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
       */
      deadlineMs: parseInt(process.env.EVER_JOBS_SEARCH_DEADLINE_MS, 120_000),
    },
    // Persistence (Spec 5024 — bounded retention on the interactive path)
    store: {
      /**
       * Persist the post-dedup canonical corpus on every `/api/jobs/search`
       * (and the GraphQL equivalent). Defaults to `true` — the historical
       * behaviour. Operators running the `memory` backend SHOULD set
       * `EVER_JOBS_PERSIST_SEARCH=false`: with an in-process store the write
       * is a pure sink (nothing in `apps/api` reads the corpus back) and it
       * pins every job description for the process lifetime.
       */
      persistSearch: parseBool(process.env.EVER_JOBS_PERSIST_SEARCH, true),
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
