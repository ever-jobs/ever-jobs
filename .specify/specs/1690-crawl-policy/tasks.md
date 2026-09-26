# Tasks: 1690 — Crawl policy: honest identity, per-host pacing, configurable proxies and back-off

> Status legend: `[ ]` pending • `[~]` in-progress • `[x]` done • `[-]` dropped

Spec: [spec.md](./spec.md) · Plan: [plan.md](./plan.md) · Operator guide:
[docs/CRAWL_POLICY.md](../../../docs/CRAWL_POLICY.md)

## Phase 0 — Contract

- [x] T01 — Crawl-policy contract: types, presets, builtin hosts, env names, errors, stubs
  - **Files:** `packages/common/src/http/crawl/{types,defaults,errors,index}.ts`, stub
    modules, `packages/plugin/src/interfaces/plugin-metadata.interface.ts` (`crawl`),
    `packages/common/src/http/index.ts`
  - **Acceptance:** commit `19384068`; `CrawlPolicy` has 24 fields; presets `polite`,
    `legacy` (byte-for-byte pre-1690), `strict`; `BUILTIN_HOST_POLICIES` for Greenhouse
    (×2), Lever, Ashby, SmartRecruiters; four errors with stable `code`s. Done.
  - **Estimate:** 0.5 day

## Phase 1 — Policy core (lane B1)

- [x] T02 — Environment parsing
  - **Files:** `packages/common/src/http/crawl/env.ts`, `policy-schema.ts`,
    `packages/common/__tests__/crawl-env.spec.ts`
  - **Acceptance:** every `CRAWL_ENV` variable read; booleans `true/false/1/0/yes/no/on/off`;
    ints ≥ 0 floored and clamped to 2^31−1; enums case-insensitive with `_`→`-`;
    statuses 100–599, `none` = []; contact inserted into the default UA from every
    layer; `RETRY_DEFAULT_*` only when set and the new twin is not; `RETRY_PER_SOURCE`
    → operator sites; policy file + env JSON merged per field; `CRAWL_EXTRA_ENV`
    switches (builtin hosts, plugin manifests, caller proxies, `DEFAULT_PROXIES`
    fallback) default on, off under `legacy`; invalid values → warnings, never a throw;
    parse cached per process. 240 tests green.
  - **Estimate:** 1 day

- [x] T03 — Layer resolution, provenance, caller filtering, host patterns
  - **Files:** `packages/common/src/http/crawl/resolve.ts`,
    `packages/common/__tests__/crawl-resolve.spec.ts`
  - **Acceptance:** six layers in order with `provenance`; `explainCrawlPolicy`;
    `stricter` per-field comparators; `none`; `blockPrivateNetworks` tighten-only for
    callers in every mode; caller UA implies `strict`; plugin UA always declared, never
    configured; plugin cannot relax `strict`; host patterns exact / `*.suffix` / `*`,
    all matches applied least specific first; `legacy` ties `maxRetryAfterMs` to
    `retryMaxDelayMs`. 153 tests green.
  - **Estimate:** 1 day

- [x] T04 — Scrape context and request context
  - **Files:** `packages/common/src/http/crawl/scrape-context.ts`,
    `packages/common/src/context/request-context.ts`,
    `packages/common/__tests__/crawl-scrape-context.spec.ts`
  - **Acceptance:** nested contexts merge, signals combine (either aborts), isolation
    per async chain; `getEffectiveCrawlPolicy` memoised (LRU 8,192 per leaf) and
    returns fresh copies; `getEffectiveProxies` order explicit → context → env →
    `DEFAULT_PROXIES` → []; `requestId` optional, `runWithRequestContext` added,
    `runWithRequestId`/`getRequestId` unchanged. 22 tests green.
  - **Estimate:** 0.5 day

## Phase 2 — Mechanisms (lane B2)

- [x] T05 — Host limiter
  - **Files:** `packages/common/src/http/crawl/host-limiter.ts`,
    `packages/common/__tests__/crawl-host-limiter.spec.ts`
  - **Acceptance:** FIFO per bucket; `maxConcurrent` (0 = unlimited); spacing of grants
    `minIntervalMs × slowdown + random(0..jitterMs)`; `CrawlQueueTimeoutError` after
    `maxWaitMs`; `AbortSignal` removes the waiter; `penalize` = max(current, now+ms)
    capped at `maxCooldownMs` (1 h); adaptive ×2 on throttled (cap 16, 500 ms floor
    when interval is 0), ×0.8 on ok; fail fast when a cool-down exceeds
    `maxCoolDownWaitMs`; LRU soft cap 10,000 never evicting busy/cooling buckets;
    chunked timers above 2^31−1 ms; `bucketKeyFor` host/domain (ICANN PSL)/site;
    `EVER_JOBS_CRAWL_MAX_BUCKETS`, `EVER_JOBS_CRAWL_MAX_COOLDOWN_MS`. Fake-clock tests.
  - **Estimate:** 1 day

- [x] T06 — Proxy selection
  - **Files:** `packages/common/src/http/crawl/proxy-selector.ts`,
    `packages/common/__tests__/crawl-proxy-selector.spec.ts`
  - **Acceptance:** `per-request` = pre-1690 round-robin from entry 0; `per-scrape`
    pins one entry per client, spread across clients; `per-host` = FNV-1a of the
    bucket key (stable across processes and restarts); `off` = direct; empty or
    `'localhost'` entry = direct.
  - **Estimate:** 0.5 day

- [x] T07 — robots.txt cache
  - **Files:** `packages/common/src/http/crawl/robots.ts`,
    `packages/common/__tests__/crawl-robots.spec.ts`, `package.json`, `package-lock.json`
  - **Acceptance:** `off` never fetches; `crawl-delay` floors the interval; `respect`
    also throws `RobotsDisallowedError`; product token `EverJobs` then `*`; LRU 5,000
    origins, TTL 6 h, error TTL 5 min; 4xx → allow; unreachable → `allow` (or
    `disallow` via env); hostile-input limits (rules per group, pattern chars, match
    cost); all `EVER_JOBS_CRAWL_ROBOTS_*` variables; `robots-parser` resolves to real
    types with and without `esModuleInterop`.
  - **Estimate:** 1 day

- [x] T08 — Egress guard
  - **Files:** `packages/common/src/http/crawl/egress-guard.ts`,
    `packages/common/__tests__/crawl-egress-guard.spec.ts`
  - **Acceptance:** private/loopback/link-local/CGNAT/benchmark/multicast/reserved IPv4,
    IPv6 equivalents, IPv4-mapped and other embedded forms, decimal/hex spellings,
    blocked suffixes (`localhost`, `local`, `internal`, `svc`, `cluster.local`,
    `localdomain`, `home.arpa`) and dotless names refused; guarded DNS lookup on shared
    keep-alive agents (insecure-TLS pair for `caCert`); `guard: false` for
    `blockPrivateNetworks: false`; allow-list via `EVER_JOBS_CRAWL_EGRESS_ALLOW_HOSTS`.
    B2 total: 227/227 tests under both jest configs.
  - **Estimate:** 1 day

## Phase 3 — HttpClient integration (lane B3)

- [x] T09 — Identity interceptor and declared-UA tracking
  - **Files:** `packages/common/src/http/http-client.ts`,
    `packages/common/__tests__/http-client.spec.ts`,
    `packages/common/__tests__/http-client-cookies.spec.ts`,
    `packages/common/__tests__/http-client-crawl-policy.spec.ts`
  - **Acceptance:** UA no longer in `axios.create` defaults; interceptor applies it;
    declared UA = per-request header > `setHeaders` (case-insensitive, other headers
    still written) > `userAgent` option; §4.2 table incl. manifest opt-in; `sec-ch-ua*`
    stripped when the configured UA goes out; `From` added; legacy precedence exact.
  - **Estimate:** 1 day

- [x] T10 — Request pipeline: egress → robots → limiter → retries
  - **Files:** as T09
  - **Acceptance:** literal egress check before robots and before any slot; guarded
    agents for direct connections, proxy agent + literal check through proxies, caller
    proxies themselves egress-checked, redirects checked; every attempt holds a slot;
    backoff exponential/linear/constant with full jitter; `Retry-After` seconds and
    HTTP-date; `give-up` vs `cap`; whole-bucket penalize + adaptive on 429/503 when
    paced; `HostCoolingDownError` fail-fast; abort from caller signal or scrape
    deadline; `timeout` survives the DTO branch; DTO caller fields ignored inside a
    scrape context; a 100-request `Promise.allSettled` fan-out never exceeds the
    bucket's concurrency and respects the interval. 80 new tests; mutation check on 6
    mechanisms turns specific tests red.
  - **Estimate:** 1.5 days

- [x] T11 — Diagnostics: crawl error codes → scrape reasons
  - **Files:** `packages/models/src/dtos/scrape-diagnostics.dto.ts`,
    `packages/models/__tests__/scrape-diagnostics-crawl.spec.ts`
  - **Acceptance:** `rate_limited` added and actionable; codes matched on the `cause`
    chain, not the message. 7 tests green.
  - **Estimate:** 0.25 day

## Phase 4 — Entry points (lane B4)

- [x] T12 — `CrawlPolicyDto` and `ScraperInputDto.crawl`
  - **Files:** `packages/models/src/dtos/crawl-policy.dto.ts`, `index.ts`,
    `scraper-input.dto.ts`, `packages/models/__tests__/crawl-policy.dto.spec.ts`
  - **Acceptance:** all 24 fields optional and validated (enums, `Min(0)`, statuses
    100–599, single-line length-capped `userAgent`/`from`); every existing field kept;
    compile-time drift check in `apps/api/src/jobs/crawl-policy.mapping.ts`.
  - **Estimate:** 0.5 day

- [x] T13 — `JobsService` scrape context, legacy mapping, deadline abort
  - **Files:** `apps/api/src/jobs/jobs.service.ts`, `crawl-policy.mapping.ts`,
    `apps/api/src/jobs/__tests__/jobs.service.crawl.spec.ts`,
    `apps/api/src/jobs/__tests__/crawl-policy.mapping.spec.ts`,
    `apps/api/__tests__/jobs/corpus-signals.spec.ts` (stub fix)
  - **Acceptance:** context carries site/plugin/caller/signal/proxies; filled DTO retry
    values never become caller overrides; only sent legacy fields map; caller proxies
    gated by `EVER_JOBS_CRAWL_CALLER_PROXIES`; deadline aborts queued and in-flight
    requests unless `EVER_JOBS_CRAWL_ABORT_ON_DEADLINE=false`; aborted scrapes are
    circuit-neutral.
  - **Estimate:** 1 day

- [x] T14 — REST, GraphQL, MCP, CLI surfaces
  - **Files:** `apps/api/src/jobs/{jobs.controller,gql-types,jobs.resolver}.ts`,
    `apps/mcp/src/{tools,index}.ts`, `apps/cli/src/commands/{crawl-options,search.command,compare.command}.ts`,
    tests `jobs.controller.crawl.spec.ts`, `jobs.resolver.crawl.spec.ts`,
    `apps/mcp/__tests__/crawl.spec.ts`, `apps/cli/__tests__/crawl-options.spec.ts`,
    `apps/api/__tests__/integration/crawl-policy.http.spec.ts`
  - **Acceptance:** GraphQL `CrawlPolicyInput` inherits DTO validators; MCP `crawl`
    object or JSON string, schema in step with the DTO, camelCase body; CLI `--crawl`,
    `--user-agent-mode`, `--proxy-rotation`, `--max-per-host`, `--min-interval-ms`,
    `--crawl-retries`, `--robots-txt`, `--discovery`, `--crawl-preset`,
    `--caller-overrides`; liveness under pseudo-site `liveness-http`, bounded by
    `EVER_JOBS_LIVENESS_DEADLINE_MS`.
  - **Estimate:** 1 day

- [x] T15 — `GET /api/sources/:site/crawl-policy`
  - **Files:** `apps/api/src/jobs/health.controller.ts`,
    `apps/api/src/jobs/__tests__/sources-crawl-policy.controller.spec.ts`
  - **Acceptance:** resolved policy + provenance + meta + warnings; `host` and `crawl`
    query params; 404/400 semantics; credentials redacted in O(n); proxy list never
    echoed (count only).
  - **Estimate:** 0.5 day

- [x] T16 — Circuit-breaker cap configurable; config mirror
  - **Files:** `packages/plugin/src/circuit-breaker/circuit-breaker.service.ts`,
    `packages/plugin/src/circuit-breaker/__tests__/circuit-breaker.max-sites.spec.ts`,
    `apps/api/src/config/configuration.ts`
  - **Acceptance:** `EVER_JOBS_CIRCUIT_MAX_SITES` (default 4096, `0` = no cap, `250` =
    pre-1690); circuit-neutral errors; read-only config mirror of the crawl policy.
    B4 total: 34 suites / 500 tests green on the fast config; API, MCP and CLI
    type-checks clean.
  - **Estimate:** 0.5 day

## Phase 5 — BrowserPool identity and plugin UA opt-ins (lane B6)

- [x] T17 — `BrowserPool` follows the crawl policy
  - **Files:** `packages/common/src/browser/{browser-pool,index}.ts`,
    `packages/common/src/browser/__tests__/browser-pool.spec.ts`
  - **Acceptance:** `identify`/`strict` use the configured UA for stealth and plain
    pages; `plugin` uses the declared UA, else the pre-1690 pool; `legacy` preset
    reproduces pre-1690 pages and persistent-profile keys; `stealth-scripts.ts`
    unchanged. 71 tests green.
  - **Estimate:** 0.5 day

- [x] T18 — USAJobs and HeadHunter opt-ins
  - **Files:** `packages/plugins/source-usajobs/src/usajobs.{constants,service}.ts`,
    `packages/plugins/source-headhunter/src/headhunter.{constants,service}.ts`,
    `usajobs.crawl.spec.ts`, `headhunter.crawl.spec.ts`
  - **Acceptance:** `userAgentMode: 'plugin'` with a documented reason; the required
    UA reaches the wire under `identify`, not under `strict` or `legacy`; BOMs kept.
  - **Estimate:** 0.25 day

## Phase 6 — Softy

- [x] T19 — Spec 1691 (see [its tasks](../1691-softy-sitemap-discovery/tasks.md))

## Phase 7 — Verification and documentation

- [x] T20 — Verification lane
  - **Files:** none in the repo (scratch only)
  - **Acceptance:** both type-checks 0 errors; real jest config 55/55 suites,
    1,769/1,769 tests, plus 6/6 suites (88 tests) outside the pattern and
    `browser-pool` 71/71; `test:scripts` 12/12 (193); plugin sweep 1,596/1,596 suites,
    15,862/15,862 tests; Softy live wire proof (Spec 1691 §6); default-search
    simulation 11.3 s vs 120 s deadline; live UA A/B over 30 plugins (Q-097).
  - **Estimate:** 1 day

- [x] T21 — Documentation
  - **Files:** `docs/CRAWL_POLICY.md` (new), `docs/adr/0001-crawl-policy.md` (new),
    this spec's §5 additions and §9, `plan.md`, `tasks.md`, `README.md`, `.env.example`,
    `tool_manifest.json`, `docs/API_CHANGELOG.md`, `docs/CLI.md`,
    `docs/PERFORMANCE_TUNING.md`, `docs/FAQ.md`, `AGENTS.md`, `CLAUDE.md`,
    `.specify/memory/constitution.md`, `docs/index.md`, `docs/log.md`,
    `docs/questions.md` (Q-097, Q-098)
  - **Acceptance:** every env variable documented with its default; presets,
    precedence, per-site/host JSON, per-request examples for REST/GraphQL/MCP/CLI,
    legacy reproduction, robots, egress, discovery, the policy endpoint and
    troubleshooting covered; rule text amended in place (nothing deleted);
    `npm run lint:docs` clean.
  - **Estimate:** 0.5 day

## Notes

- Recorded as a follow-up in [plan.md](./plan.md) §8, now resolved: the blocking
  **Test (Core)** CI job (`npm run test:core`, Spec 1689, merged in from `develop`) runs
  `packages/common/__tests__` — the crawl-policy suites included — and the other core
  suites. Before that merge no job ran them.

- Tests were written alongside each implementation task, per lane.
- No `console.log` was added (Nest `Logger` throughout; the CLI keeps its existing
  `console.error` warnings).
- Every touched file kept its line endings and BOM.
