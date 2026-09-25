# Plan: 1690 — Crawl policy: honest identity, per-host pacing, configurable proxies and back-off

| Field        | Value                              |
| ------------ | ---------------------------------- |
| Spec         | [spec.md](./spec.md)               |
| Created      | 2026-09-24                         |
| Last updated | 2026-09-25                         |

## 1. Approach

The audit behind [spec.md](./spec.md) §1 showed that every politeness defect a site
operator reported against `source-ats-softy` is really a defect of the shared HTTP
layer: the client-level `User-Agent` default beat every UA a plugin declared, nothing
bounded concurrency toward one host across plugins, proxy rotation was per request,
and retries ignored long `Retry-After` values. Fixing ~1,850 plugins one by one is not
feasible, so the fix lives in `@ever-jobs/common` and reaches every plugin without
editing its call sites.

The central idea is one value object, `CrawlPolicy` (24 knobs), resolved **per
request** from six layers — preset, env-global, builtin host, plugin, operator
site/host, caller — with a `provenance` map naming the layer that set each field.
Every knob is settable at every layer (owner rule: maximum flexibility), and nothing
old is removed: the pre-1690 behaviour is the `legacy` preset, and each piece of it is
also reachable on its own.

The per-search values (site, plugin manifest, the caller's `crawl`, the deadline
`AbortSignal`, the caller's proxies) travel through `AsyncLocalStorage` (a scrape
context opened by `JobsService.scrapeOne`), so `HttpClient` and `BrowserPool` pick
them up inside any plugin without a signature change. The process-wide mechanisms —
host limiter, robots.txt cache, DNS-guarded agents — are singletons with injectable
instances for tests.

Work was split into a contract commit (types, presets, errors, stub signatures) and
six implementation lanes with disjoint file ownership, so lanes could run in parallel
against a fixed interface. Each lane shipped its own tests; a final verification lane
ran the type-checks, the real jest config, the full plugin sweep, a live Softy wire
proof, an offline default-search simulation and a live UA A/B across 30 plugins.

Defaults were chosen to need **no** production env change: the polite preset keeps a
default search inside its 120 s deadline (builtin higher limits for bulk ATS APIs),
and robots.txt stays opt-in. See Q-097 and Q-098 for the two defaults most likely to
be revisited.

## 2. Phases

### Phase 0 — Contract (commit `19384068`)

- Goal: freeze the interface so lanes can work in parallel.
- Deliverables: `types.ts`, `defaults.ts` (presets, builtin hosts, `CRAWL_ENV`),
  `errors.ts`, signature stubs for every other module, `IPluginMetadata.crawl`,
  spec.md for 1690 and 1691.
- Exit criteria: type-check clean; stubs throw "not implemented".

### Phase 1 — Policy core (lane B1)

- Goal: env parsing, layer resolution with provenance, caller filtering, scrape context.
- Deliverables: `env.ts`, `resolve.ts`, `scrape-context.ts`, new `policy-schema.ts`
  (shared field schema and coercion, so `env.ts` and `resolve.ts` need not import
  each other), `request-context.ts` (`scrape` slot, optional `requestId`).
- Exit criteria: every `CRAWL_ENV` variable parsed with warnings for bad values;
  precedence and provenance tested per layer; 415 tests green.

### Phase 2 — Mechanisms (lane B2)

- Goal: the process-wide pacing, proxy, robots and egress machinery.
- Deliverables: `host-limiter.ts`, `proxy-selector.ts`, `robots.ts`, `egress-guard.ts`;
  dependencies `robots-parser`, `tldts` (see §4).
- Exit criteria: fake-clock limiter tests (concurrency, spacing under a 100-wide
  burst, jitter bounds, cool-down, adaptive, abort, max wait, LRU); 227 tests green.

### Phase 3 — `HttpClient` integration (lane B3)

- Goal: every request made through `HttpClient` obeys the resolved policy.
- Deliverables: request interceptor for identity; egress → robots → limiter →
  retry/back-off pipeline; new client options; `ScrapeReason` `rate_limited`.
- Exit criteria: wire UA per mode (incl. `setHeaders` and per-request headers);
  legacy preset reproduces pre-1690 wire behaviour; mutation check turns tests red.

### Phase 4 — Entry points (lane B4)

- Goal: every caller surface can set the policy; the API can show it.
- Deliverables: `CrawlPolicyDto` + `ScraperInputDto.crawl`; GraphQL `CrawlPolicyInput`;
  MCP `crawl` (and the camelCase body fix); CLI flags; `JobsService` scrape context,
  legacy-field mapping and deadline abort; liveness pseudo-site;
  `GET /api/sources/:site/crawl-policy`; configurable circuit-breaker cap.
- Exit criteria: 34 suites / 500 tests green on the fast config; API, MCP, CLI
  type-checks clean.

### Phase 5 — Browser identity and plugin UA opt-ins (lane B6)

- Goal: `BrowserPool` follows the same identity rules; sources whose API requires a
  specific UA keep working under `identify`.
- Deliverables: `resolveBrowserUserAgent`, `BrowserPageOptions.userAgent/host/crawl`;
  `USAJOBS_CRAWL_POLICY`, `HEADHUNTER_CRAWL_POLICY`.
- Exit criteria: 70 tests green; BOMs on the touched plugin services preserved.

### Phase 6 — Softy (lane B5, Spec 1691)

- See [../1691-softy-sitemap-discovery/plan.md](../1691-softy-sitemap-discovery/plan.md).

### Phase 7 — Verification and docs

- Goal: prove the whole, document it for operators and plugin authors.
- Deliverables: verification report (spec §9.4), `docs/CRAWL_POLICY.md`, ADR 0001,
  README / `.env.example` / `tool_manifest.json` / API changelog / AGENTS.md /
  CLAUDE.md / constitution amendments, index, log, questions.
- Exit criteria: `npm run lint:docs` clean.

## 3. Packages Touched

| Package                        | Change                                |
| ------------------------------ | ------------------------------------- |
| `packages/common`              | new `http/crawl/*` modules; `HttpClient` rewritten around the policy (all old options kept); `BrowserPool` identity; request context |
| `packages/models`              | `CrawlPolicyDto`; `ScraperInputDto.crawl`; `ScrapeReason` `rate_limited`, `CRAWL_ERROR_SCRAPE_REASONS` |
| `packages/plugin`              | `IPluginMetadata.crawl`; circuit breaker cap configurable, deadline aborts neutral |
| `packages/plugins/source-ats-softy` | Spec 1691 |
| `packages/plugins/source-usajobs`, `source-headhunter` | `userAgentMode: 'plugin'` opt-ins with reasons |
| `apps/api`                     | scrape context, legacy mapping, deadline abort, GraphQL input, policy endpoint, config mirror |
| `apps/cli`                     | crawl flags on `search` and `compare` |
| `apps/mcp`                     | `crawl` argument; camelCase request body |
| root                           | `package.json` / `package-lock.json` (two dependencies) |

## 4. Dependencies

| Library                | Version  | Rationale                            |
| ---------------------- | -------- | ------------------------------------ |
| `robots-parser`        | `^3.0.1` | New direct dependency (constitution Art. 9.3). An RFC 9309 parser (groups, `*`/`$` wildcards, longest-match Allow/Disallow, `Crawl-delay`, `Sitemap:`) is easy to get subtly wrong by hand; this one is MIT, CommonJS, has **no dependencies and no install scripts**, ships its own TypeScript types, and does no I/O (we fetch the file ourselves through the limiter with our UA). Alternatives: a hand-rolled parser (rejected: wildcard/precedence edge cases), packages that fetch robots.txt themselves (rejected: would bypass pacing, identity and the egress guard). Hostile-input limits (rule count, pattern length, matcher cost) are applied by our wrapper before parsing. |
| `tldts`                | `^7.4.11` | Promoted from transitive to direct (it was already installed through `tough-cookie` ^6, Spec 5093) — no new code enters the install tree. Needed for the registrable domain (Public Suffix List) behind `rateLimitScope: 'domain'` and the sitemap `same-domain` nested scope; a hand-kept suffix list would be wrong for multi-label suffixes (`co.uk`, `com.au`). Pinned at the installed 7.4.11 to avoid an unrelated bump. |

The lockfile was patched by hand (+11 lines: two root dependency lines and the
`node_modules/robots-parser` entry): `npm install --package-lock-only` would also have
deleted 257 lines of stale `express/node_modules/*` entries and flipped an unrelated
`dev` flag. `npm ci --dry-run` accepts the result; the tarball's sha512 matches.
`p-limit` was deliberately **not** added: its current majors are ESM-only, which Jest's
`transformIgnorePatterns` does not transform, and a per-host limiter needs a shared
process-wide queue anyway.

## 5. Risks & Mitigations

| Risk                                | Likelihood | Impact | Mitigation                  |
| ----------------------------------- | ---------- | ------ | --------------------------- |
| Default pacing pushes sources past the 120 s search deadline | M | H | Builtin host limits for bulk ATS APIs; simulation: 11.3 s for 800 Greenhouse + 100 ordinary requests; `EVER_JOBS_CRAWL_MAX_CONCURRENT_PER_HOST` / operator host policy; Q-098 |
| Some sites refuse the honest UA | M | M | `userAgentMode: 'plugin'` opt-in with reason, operator `sites.<site>.userAgentMode`, `EVER_JOBS_CRAWL_USER_AGENT=browser`, or the `legacy` preset; live A/B recorded in Q-097 |
| Egress guard breaks local mock servers / e2e | M | L | `EVER_JOBS_CRAWL_BLOCK_PRIVATE_NETWORKS=false` or `EVER_JOBS_CRAWL_EGRESS_ALLOW_HOSTS` |
| A hostile `Retry-After` / robots.txt wedges a shared bucket or burns CPU | L | M | Cool-down ceiling (`EVER_JOBS_CRAWL_MAX_COOLDOWN_MS`, 1 h), chunked timers, robots size/rule/pattern/match-cost limits |
| Deadline aborts trip circuit breakers | M | M | Aborted scrapes are circuit-neutral |
| Plugin specs that stub `createHttpClient` break on new instance methods | L | M | New client surface is additive and optional; full plugin sweep 1,596/1,596 suites green |
| Per-request resolution cost | L | L | Env parse cached per process; policies memoised per (env, manifest, caller, site, host, options) |
| Operators misconfigure JSON policies | M | L | Invalid values dropped with warnings, never a crash; `GET /api/sources/:site/crawl-policy` shows the result and the warnings |

## 6. Rollback Plan

No data is written, so rollback is configuration only:

- Whole behaviour: `EVER_JOBS_CRAWL_PRESET=legacy` (pre-1690 wire behaviour, including
  UA precedence, per-request rotation, no pacing, linear retries, no egress guard;
  builtin hosts, manifests and the `DEFAULT_PROXIES` fallback off).
- Single pieces: any `EVER_JOBS_CRAWL_*` variable, e.g. `..._USER_AGENT=browser`,
  `..._MAX_CONCURRENT_PER_HOST=0`, `..._MIN_INTERVAL_MS=0`, `..._PROXY_ROTATION=per-request`,
  `..._BLOCK_PRIVATE_NETWORKS=false`, `..._ABORT_ON_DEADLINE=false`,
  `EVER_JOBS_CIRCUIT_MAX_SITES=250`.
- Code: revert the feature commits; the contract commit alone is inert.

## 7. Migration Plan (if applicable)

- **Env:** none required. `RETRY_DEFAULT_*` and `RETRY_PER_SOURCE` keep working (mapped
  into the env-global and operator-site layers). `DEFAULT_PROXIES`, parsed and never
  used before, is now used as the fallback proxy list — set
  `EVER_JOBS_CRAWL_DEFAULT_PROXIES_FALLBACK=false` to keep ignoring it.
- **API callers:** additive. Legacy flat fields map into the caller layer only when
  sent; a sent `userAgent` still goes on the wire (it implies `strict`).
- **MCP callers:** `search_jobs` now actually filters by term/source (the snake_case
  body was being stripped); results change from a whole-catalogue fan-out to the
  requested search.
- **Plugin authors:** optional `crawl` in `@SourcePlugin`; declared UAs are only sent
  when the resolved mode allows (see `docs/CRAWL_POLICY.md` §"For plugin authors").

## 8. Open Questions for Plan

- Q-097 — default UA mode and which plugins opt into `plugin` mode.
- Q-098 — default pacing numbers (4 per host, 100 ms, builtin bulk hosts).
- CI coverage of `packages/common/__tests__`: resolved outside this spec. When this
  work was written no CI job ran those suites (the politeness tests ran locally and in
  the verification lane only); Spec 1689, merged in from `develop`, added the blocking
  **Test (Core)** job (`npm run test:core`), which now runs every `packages/common`
  suite — the crawl-policy ones included — alongside the models / plugin / API / MCP
  core suites. The merge also added `apps/cli/__tests__` to `test:core` (Spec 1689's
  guard requires every non-e2e spec under `apps/` there), so the CLI's
  `crawl-options.spec.ts` runs in Test (Core) too; the Softy / USAJobs / HeadHunter /
  SimplyHired plugin suites run in the source unit shards.
