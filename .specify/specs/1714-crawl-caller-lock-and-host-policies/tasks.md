# Tasks: 1714 — Crawl policy: site-owner caller lock, host-owned policies, gentler pacing knobs

> Status legend: `[ ]` pending • `[~]` in-progress • `[x]` done • `[-]` dropped

Spec: [spec.md](./spec.md) · Plan: [plan.md](./plan.md) · Operator guide:
[docs/CRAWL_POLICY.md](../../../docs/CRAWL_POLICY.md) · Plugin half:
[Spec 1715](../1715-softy-audit-hardening/tasks.md)

**Status (2026-09-27, review round 2):** in progress. T01–T19 are done (the docs pass checked the
operator guide, changelog, README, index and questions against the landed code and added
Q-126..Q-128). Review round 2 (Phase 4, T21–T32) landed its code, tests and docs,
including **T26** (`JobsService` fills `ScrapeContext.callerRequestTimeout`). Left:
**T20** — the orchestrator's joint verification of the three lanes, round 2
included (typecheck, `test:core`, `test:sources` for Softy / liveness-http / every suite
reaching `*.softy.pro`, `test:scripts`, `lint:docs`, every red control with command and
result, the gap and finding tables confirmed). The spec moves to `done` when both are ticked.

Every task names its lane (plan §3 — disjoint file ownership), the audit gaps it closes,
and for each key test a **red control**: run the test once with the named legacy switch
(or the named one-line mutation, reverted afterwards) and show it fails for the stated
reason, then passes with the new default. Report both runs with the exact command.
Commands run from the worktree root with the Bash tool
(`cd /e/Coding/Worktrees/ever-jobs-softy-audit-fixes && …`); one area:
`npx jest --testPathPatterns <path>`; typecheck: `npx tsc -p tsconfig.typecheck.json --noEmit`.

## Phase 0 — Contract (CORE lands this first)

- [x] T01 — [CORE] Golden capture of policy resolution BEFORE any resolver change (FR-17)
  - **Files:** `packages/common/__tests__/fixtures/crawl-resolve-golden-1690.json` (new),
    `packages/common/__tests__/crawl-resolve.golden.spec.ts` (new)
  - **Acceptance:** a small capture script inside the spec (`UPDATE_GOLDEN=1` writes the
    fixture) records, from the unchanged code, `explainCrawlPolicy` for the cases below under
    the default env (`any`) and under `EVER_JOBS_CRAWL_CALLER_OVERRIDES=none` (both must stay
    identical; `stricter` changes on purpose, T04): sites `linkedin`, `greenhouse` (host `boards-api.greenhouse.io`),
    `usajobs` (plugin opt-in manifest), `liveness-http` (host `jobs.example.com`), a
    plugin manifest `{ rateLimitScope: 'domain', maxConcurrentPerHost: 1 }` without a lock,
    each with no caller, with a broad caller override (`userAgent`, `proxyRotation:
    'per-request'`, `rateLimitScope: 'site'`, `minIntervalMs: 0`, `retries: 5`,
    `retryStatuses: [500]`, `discovery: 'listing'`); stores
    the Spec 1690 fields, `provenance` and `callerRejected`. The fixture header records the
    commit it was captured on. The spec asserts equality on those keys (new fields
    ignored). Passes on the unchanged code.
  - **Red control:** after T03, mutate the effective-mode default to `stricter` → the
    `any` cases go red; revert.
  - **Estimate:** 0.25 day

- [x] T02 — [CORE] Contract: types, presets, builtin Softy entry, env names, helpers, models
  - **Files:** `packages/common/src/http/crawl/{types,defaults,policy-schema,env,index}.ts`,
    new `packages/common/src/http/crawl/caller-lock.ts`,
    `packages/models/src/dtos/{crawl-policy,job-post,scrape-diagnostics}.dto.ts`,
    `packages/plugin/src/interfaces/plugin-metadata.interface.ts` (doc comment on `crawl`:
    `callerOverrides` lock), `packages/common/__tests__/crawl-env.spec.ts`,
    new `packages/common/__tests__/crawl-caller-lock.spec.ts` (pure helpers part)
  - **Gaps:** contract for G0, G3, G5, G7, G9, G10, G12, G14, G15, G27, K3, G4/G28
  - **Acceptance:**
    - `CrawlPolicy.minGapMs`, `serverErrorCooldownMs` (spec §7.1), in
      `CRAWL_POLICY_FIELD_SPECS` as `int`, 0 in all three presets; `CRAWL_POLICY_FIELDS`
      has 27 entries; `ENV_FIELDS` maps `EVER_JOBS_CRAWL_MIN_GAP_MS`,
      `EVER_JOBS_CRAWL_SERVER_ERROR_COOLDOWN_MS`.
    - `CrawlPolicyOverride` = `Partial<CrawlPolicy> & { callerOverrides? }`;
      `normalizeOverride` accepts `callerOverrides` (case-insensitive enum; invalid →
      warning, dropped); `CallerOverridesSource`, `CallerOverridesResolution` exported.
    - `BUILTIN_SOFTY_HOST_POLICY` exactly as spec §7.1; `BUILTIN_HOST_POLICIES['*.softy.pro']`
      and `['softy.pro']` point to it (the resolver still matches exact keys until T03).
    - `CRAWL_EXTRA_ENV.{FLEET_SIZE, STRICTER_RULES, PROXY_PIN_SCOPE, ROBOTS_BACKOFF}` parsed
      into `ParsedCrawlPolicyEnv` (fleet 1..1000, clamped with a warning; enums and booleans
      as Spec 1690; invalid → default + warning); accessors `crawlFleetSize`,
      `crawlStricterRules`, `crawlProxyPinScope`, `crawlRobotsBackoffEnabled`,
      `crawlCallerProxiesAllowedFor` (spec FR-5 rule). Each switch's doc comment names the
      value that restores pre-1714 behaviour.
    - `caller-lock.ts`: `CALLER_OVERRIDES_RANK`, `mostRestrictiveCallerOverrides`,
      `DEFAULT_REQUEST_TIMEOUT_SECONDS = 60`, `gateCallerRequestTimeout` (table: `any` →
      unchanged, `stricter` → value if finite ≥ default else default, `none` → default,
      rules `1690` → unchanged).
    - Signatures of `resolveCallerOverrides`, `getEffectiveCrawlResolution`,
      `proxyPinKeyFor`, `isSitemapStopError`, `isServerStruggling`, `SERVER_ERROR_STATUSES`
      exported with a working implementation or one that returns today's behaviour, so the
      other lanes compile; filled in by T03–T09.
    - Models: `CrawlPolicyDto.minGapMs` / `serverErrorCooldownMs` (`@IsOptional @IsInt
      @Min(0)`, Swagger text naming the env var and "0 = off"); no `callerOverrides`;
      `JobPostDto.jobUrlFetchedAt`, `liveness.reason`, `JOB_LIVENESS_REASON_FRESH_FETCH =
      'fresh-fetch'`; `preferRefusalError` (spec §7.2) exported from the models index.
    - `apps/api/src/jobs/crawl-policy.mapping.ts` compile-time drift checks still hold
      (DTO ↔ `CrawlPolicy`).
    - `npx tsc -p tsconfig.typecheck.json --noEmit` clean.
  - **Tests:** env parsing of the 6 variables (valid, invalid, clamp); caller-lock helper
    tables. No red control needed (pure parsing); the gate table's control is
    `rules: '1690'` → every row passes through.
  - **Estimate:** 0.5 day

## Phase 1 — CORE mechanisms

- [x] T03 — [CORE] Builtin host patterns and the effective caller mode in the resolver
  - **Files:** `packages/common/src/http/crawl/resolve.ts`,
    `packages/common/__tests__/crawl-caller-lock.spec.ts`,
    `packages/common/__tests__/crawl-resolve.spec.ts` (expectations that now see the
    builtin `*.softy.pro` layer)
  - **Gaps:** G0, G2, G3, G4, G8, G9, G11, G12, G28 (with T04, T07)
  - **Acceptance:**
    - Layer 3: every `BUILTIN_HOST_POLICIES` key matching the host (`hostMatches`), least
      specific first (`hostPatternSpecificity`, ties in declaration order); `builtinHost`
      keeps its meaning (the host, when any pattern applied); new
      `builtinHostPatterns`. `EVER_JOBS_CRAWL_BUILTIN_HOSTS=false` skips the layer and its
      lock (note as today).
    - Effective mode (spec FR-2, D3): start at the global mode (source `default` when
      unset, else `env-global`); fold in each applied builtin pattern's `callerOverrides`,
      then the plugin layer's (manifest when manifests are enabled, then explicit client
      options), taking a candidate when its rank is ≥ the current one (so on a tie the
      higher layer is the source); then operator site value, then operator host patterns
      least specific first — the last operator value set replaces the mode outright
      (source `operator-site` / `operator-host`). The caller layer is filtered with it.
      `callerOverrides` never becomes a policy field and is always in `callerRejected`
      when a caller sends it.
    - `resolveCallerOverrides(input, env)` returns the same `{ mode, source, global }`
      without building a policy. Explanation gains `callerOverrides` (effective),
      `callerOverridesSource`, `globalCallerOverrides`, `builtinHostPatterns`,
      `baseRateLimitScope` (scope before the caller layer); a note when a lock tightened the
      global mode.
  - **Tests (crawl-caller-lock.spec.ts):**
    1. Softy manifest lock under global `any` refuses the G0/G3/G5/G9/G12/G22 override
       (spec §8 row 1) and accepts the polite ones. **Red control:**
       `EVER_JOBS_CRAWL_PLUGIN_MANIFESTS=false` → all accepted.
    2. Site `liveness-http`, hosts `acme.softy.pro` and `softy.pro` get the Softy pacing
       and `callerOverrides` stricter from `builtin-host`; `acme.softy.pro.evil.com` and
       `notsofty.pro` do not. **Red control:** `EVER_JOBS_CRAWL_BUILTIN_HOSTS=false` →
       polite `host`/4/100.
    3. Operator `sites.softy.callerOverrides: 'any'` loosens, `hosts["*.softy.pro"]:
       'none'` tightens, host beats site; global `none` + plugin `stricter` = `none`
       (`env-global`); plugin `any` cannot loosen a global `stricter`. **Red control:**
       drop the operator entry → the plugin mode returns.
    4. A caller's `callerOverrides: 'any'` is refused under every mode.
  - **Estimate:** 1 day

- [x] T04 — [CORE] `stricter` comparators, rules `1714` / `1690`
  - **Files:** `packages/common/src/http/crawl/resolve.ts` (`filterCallerOverride`,
    `isAtLeastAsStrict`), `packages/common/__tests__/crawl-resolve.spec.ts`
  - **Gaps:** G3, G5, G10, G12, G22
  - **Acceptance:** the §7.3 table exactly, selected by `options.rules` (from
    `crawlStricterRules(env)` inside `explainCrawlPolicy`); the new fields have a "higher
    or equal" comparator under both rule sets; exhaustive `switch` (the compiler flags a
    field without a comparator). Doc comment of `filterCallerOverride` shows both columns.
  - **Tests:** the existing `TABLE` becomes the `1714` table (rows changed: `rateLimitScope`
    accepts `host`, `domain`, rejects `site`; `proxyRotation` accepts `per-host`, `off`,
    rejects `per-scrape`, `per-request`, and `per-host` under an `off` base is refused;
    `retryStatuses` accepts `[429, 503]`, `[429, 502, 503]`, rejects `[]`, `[429]`,
    `[429, 500]`; `discovery` accepts `auto`, `sitemap`, rejects `listing`; new rows for
    `minGapMs`, `serverErrorCooldownMs`); a second table pins the `1690` rules (the old
    rows); "table covers every field" still holds. **Red control:** run the `1714` table
    with `EVER_JOBS_CRAWL_STRICTER_RULES=1690` → the changed rows fail (accepted instead of
    refused).
  - **Estimate:** 0.5 day

- [x] T05 — [CORE] Scrape context: resolution with the lock, proxies without the caller's
  - **Files:** `packages/common/src/http/crawl/scrape-context.ts`,
    `packages/common/__tests__/crawl-scrape-context.spec.ts`
  - **Gaps:** G9 (with T07)
  - **Acceptance:** `getEffectiveCrawlResolution(host, explicit)` memoised in the same
    leaves as today (value = `{ policy, callerOverrides, baseRateLimitScope }`), returns
    fresh copies; `getEffectiveCrawlPolicy` delegates and keeps its signature;
    `getEffectiveProxies(explicit, { ignoreCallerProxies: true })` skips the scrape
    context's proxies (explicit, then env, then `DEFAULT_PROXIES` as before).
  - **Tests:** memo hit returns equal resolutions; `ignoreCallerProxies` order.
  - **Estimate:** 0.25 day

- [x] T06 — [CORE] Host limiter: idle gap after completion
  - **Files:** `packages/common/src/http/crawl/host-limiter.ts`,
    `packages/common/__tests__/crawl-host-limiter.spec.ts`
  - **Gaps:** G7
  - **Acceptance:** `HostLimiterAcquireExtraOptions.minGapMs`; on `release()` of a granted
    request, `nextStartAt = max(nextStartAt, now + minGapMs)` before pumping; idempotent
    release; a bucket inside its gap is not evicted (existing `isIdle` rule).
  - **Tests:** fake clock, 1 in flight, interval 1000, gap 500: grant t=0, release t=1500
    → next grant t=2000; release t=200 → next grant t=1000 (interval dominates).
    **Red control:** `minGapMs: 0` → next grant t=1500.
  - **Estimate:** 0.25 day

- [x] T07 — [CORE] `HttpClient`: proxy pin on the base scope, caller proxies under a host lock
  - **Files:** `packages/common/src/http/crawl/proxy-selector.ts` (`proxyPinKeyFor`),
    `packages/common/src/http/http-client.ts` (`resolvePolicy` returns the resolution,
    `RequestPlan.resolution`, `sendUnderPolicy`, `clientOptionsFromScraperInput` sets
    `proxiesFromCaller`), `packages/common/__tests__/{crawl-proxy-selector,http-client-crawl-policy}.spec.ts`
  - **Gaps:** G9, G10, G11
  - **Acceptance:** the `per-host` pick uses `proxyPinKeyFor(url, policy.rateLimitScope,
    baseRateLimitScope, site, crawlProxyPinScope(env))` (domain key when the base scope is
    `domain`, else the bucket key; `bucket` = pre-1714); when
    `crawlCallerProxiesAllowedFor(resolution.callerOverrides, env)` is false, the request
    uses `getEffectiveProxies(this.proxiesFromCaller ? undefined : this.proxies, {
    ignoreCallerProxies: true })`; the rate-limit bucket itself is unchanged.
  - **Tests (axios adapter fakes, env proxies `p1..p4`, no network):** spec §8 rows
    "pin" and "DTO-branch client". **Red controls:** `EVER_JOBS_CRAWL_PROXY_PIN_SCOPE=bucket`
    → the two tenants get different proxies (FNV values as computed in the audit);
    `EVER_JOBS_CRAWL_BUILTIN_HOSTS=false` → the caller proxy is used for `acme.softy.pro`.
  - **Estimate:** 0.5 day

- [x] T08 — [CORE] `HttpClient`: server-error cool-down, fleet size, robots.txt back-off
  - **Files:** `packages/common/src/http/http-client.ts` (`SERVER_ERROR_STATUSES`,
    `isServerStruggling`, `recordAnswerOutcome`, `crawlAcquireOptions`, `acquireOptions`,
    `sendUnderPolicy`, `fetchRobotsTxt`), `packages/common/__tests__/http-client-crawl-policy.spec.ts`,
    `packages/common/src/browser/__tests__/browser-navigate.spec.ts` (one case: a navigation answering
    502 cools the bucket)
  - **Gaps:** G14, G15 (part), G18, G27
  - **Acceptance:**
    - FR-10: a thrown answer with status 500/502/504, or no response with a timeout
      (`ECONNABORTED`, `ETIMEDOUT`, `ESOCKETTIMEDOUT`, `ERR_SOCKET_CONNECTION_TIMEOUT`,
      `UND_ERR_CONNECT_TIMEOUT`) or reset (`ECONNRESET`, `UND_ERR_SOCKET`, "socket hang
      up"), penalises the bucket `serverErrorCooldownMs` (before any retry sleep); never
      for `ERR_CANCELED` / abort / crawl-policy errors / DNS failures;
      `recordAnswerOutcome` does the same for an accepted 500/502/504 and reports
      `serverErrorCooldownMs`.
    - FR-11: `crawlAcquireOptions(policy, signal, crawlDelayMs, fleetSize)` multiplies
      `max(minIntervalMs, crawlDelayMs)` and `minGapMs` by the fleet size;
      `HttpClient.acquireOptions` multiplies `minIntervalFloorMs` too; `BrowserPool`
      unchanged (uses the default argument).
    - FR-12: `fetchRobotsTxt` calls `recordAnswerOutcome` for its answer when
      `crawlRobotsBackoffEnabled(env)`; a give-up throws `HostCoolingDownError(bucket, ms,
      status)` (the robots cache treats it as a local failure: not cached, rethrown).
  - **Tests:** spec §8 rows "502 / timeout / reset", "fleet", "robots". **Red controls:**
    `serverErrorCooldownMs: 0` → no cool-down; fleet `1` → 1000 / 500;
    `EVER_JOBS_CRAWL_ROBOTS_BACKOFF=false` → the page request is sent at once.
  - **Estimate:** 0.75 day

- [x] T09 — [CORE] `fetchSitemap` stops on push-back from a nested document
  - **Files:** `packages/common/src/http/crawl/sitemap.ts`,
    `packages/common/__tests__/crawl-sitemap.spec.ts`
  - **Gaps:** G16
  - **Acceptance:** `nestedErrors` option (default `stop-on-throttle`): a nested fetch error
    for which `isSitemapStopError(err)` is true (HTTP 429/503 on `err.response.status`, or a
    `CrawlPolicyError` up to five `cause` links down) is rethrown and the walk ends; other
    nested errors go to `onError` as before; `skip` = pre-1714. Root errors unchanged.
  - **Tests:** index with 3 children, child 1 → 429: rejects with it, children 2–3 not
    requested; child 1 → `HostCoolingDownError`: same; child 1 → 404: skipped, 2–3
    requested. **Red control:** `nestedErrors: 'skip'` → children 2–3 requested after the
    429.
  - **Estimate:** 0.25 day

- [x] T10 — [CORE] Models tests
  - **Files:** `packages/models/__tests__/scrape-diagnostics-crawl.spec.ts`,
    `packages/models/__tests__/crawl-policy.dto.spec.ts`, `packages/models/__tests__/job-post-board-fields.spec.ts`
  - **Gaps:** G17 (helper), contract
  - **Acceptance:** `preferRefusalError`: 502 then 429 → 429; 429 then 502 → 429; 502 then
    500 → 502; 500 then 503 → 503; `undefined` then x → x; a crawl `HostCoolingDownError`
    wins over a 5xx. DTO: `minGapMs: -1` / `1.5` / `'x'` rejected, `0` / `500` accepted;
    `callerOverrides` is not a DTO property (whitelist strips it).
  - **Red control:** mutate `preferRefusalError` to return `current` → the first two rows
    fail.
  - **Estimate:** 0.25 day

## Phase 1 — API entry points (parallel with CORE after T02)

- [x] T11 — [API] Policy API shows the effective lock
  - **Files:** `apps/api/src/jobs/health.controller.ts` (`SourceCrawlPolicyResponse.meta`,
    `crawlPolicy`), `apps/api/src/jobs/__tests__/sources-crawl-policy.controller.spec.ts`,
    `apps/api/__tests__/integration/crawl-policy.http.spec.ts`
  - **Gaps:** G0 (visibility)
  - **Acceptance:** `meta.callerOverrides` = effective, `meta.callerOverridesProvenance`,
    `meta.globalCallerOverrides`, `meta.builtinHostPatterns`, `meta.fleetSize`
    (`crawlFleetSize(env)`); the top-level policy carries `minGapMs`,
    `serverErrorCooldownMs`; Swagger description mentions the lock.
  - **Tests:** `softy` (plugin, stricter), `softy?host=acme.softy.pro` (plugin, patterns
    `['*.softy.pro']`), `liveness-http?host=acme.softy.pro` (builtin-host), `linkedin`
    (default, `any`), operator `sites.softy.callerOverrides: 'any'` (operator-site);
    `?crawl={"proxyRotation":"per-request","discovery":"listing"}` on softy → both in
    `meta.caller.rejected`. Existing expectations for `acme.softy.pro` updated for the
    builtin layer.
  - **Estimate:** 0.25 day

- [x] T12 — [API] New policy fields on every request surface; config mirror
  - **Files:** `apps/api/src/jobs/gql-types.ts` (`CrawlPolicyInput`), `apps/mcp/src/tools.ts`
    (`CRAWL_POLICY_INPUT_SCHEMA`; `normalizeMcpCrawl` forwards any key and needs no change),
    `tool_manifest.json`, `apps/api/src/config/configuration.ts` (`crawl.fleetSize`,
    `crawl.stricterRules`, `circuit.countRefusals`), tests
    `apps/api/src/jobs/__tests__/gql-types.schema.spec.ts`, `apps/mcp/__tests__/{crawl,tool-manifest}.spec.ts`
  - **Gaps:** G7, G14 (reachable per request), contract
  - **Acceptance:** `minGapMs`, `serverErrorCooldownMs` as nullable non-negative `Int`
    (GraphQL), `integer, minimum 0` (MCP schema and manifest); `callerOverrides` on no
    surface; drift tests green.
  - **Estimate:** 0.25 day

- [x] T13 — [API] `JobsService.scrapeOne`: caller proxies and `requestTimeout` under the lock
  - **Files:** `apps/api/src/jobs/jobs.service.ts` (`scrapeOne`, `callerProxies`, the
    search-level "proxies ignored" warning), `apps/api/src/jobs/crawl-policy.mapping.ts`
    (`callerRequestTimeout(input, lock, env)` built on `gateCallerRequestTimeout` +
    `crawlStricterRules`), tests `apps/api/src/jobs/__tests__/{jobs.service.crawl,crawl-policy.mapping}.spec.ts`
  - **Gaps:** G9, G29 (Softy part), K3
  - **Acceptance:** per source, `lock = resolveCallerOverrides({ site, plugin:
    this.pluginCrawlPolicy(site) }, env)`; `proxies` kept only when
    `crawlCallerProxiesAllowedFor(lock, env)`; `requestTimeout` = the gated value (logged at
    debug when replaced); the DTO and the scrape context both get the result; sources
    without a lock under `any` get exactly today's DTO. REST, GraphQL, MCP (via REST) and
    CLI all reach this one place, so no per-entry-point code is added; MCP sends no
    `requestTimeout` at all and GraphQL has no such input (the DTO default 60 applies).
  - **Tests:** spec §8 row "JobsService". **Red controls:**
    `EVER_JOBS_CRAWL_STRICTER_RULES=1690` → `0.2` reaches Softy; operator
    `sites.softy.callerOverrides: 'any'` → the caller proxies are kept.
  - **Estimate:** 0.5 day

- [x] T14 — [API] Multi-location loop stops on 503
  - **Files:** `apps/api/src/jobs/jobs.service.ts` (`refusalFromError`,
    `refusalFromDiagnostics`), `apps/api/src/jobs/crawl-policy.mapping.ts`
    (`SEARCH_STOP_ON_503_ENV`, `searchStopOn503(env)`),
    `apps/api/src/jobs/__tests__/jobs.service.multi-location.spec.ts`
  - **Gaps:** G17
  - **Acceptance:** a thrown `response.status === 503` and a `fetch_error` diagnostic whose
    detail matches `/\b503\b|service unavailable/i` are refusals (`fetch_error`);
    `rate_limited`, `blocked`, `circuit_open`, 429 unchanged;
    `EVER_JOBS_SEARCH_STOP_ON_503=false` = pre-1714.
  - **Tests:** 3 locations; location 1 resolves `fetch_error` "Request failed with status
    code 503" → locations 2–3 `not attempted`; same thrown; a `rate_limited` diagnostic
    after an earlier location's plain 502 → stops. **Red control:**
    `EVER_JOBS_SEARCH_STOP_ON_503=false` → locations 2–3 attempted.
  - **Estimate:** 0.25 day

- [x] T15 — [API] Circuit breaker counts refused empty results
  - **Files:** `packages/plugin/src/circuit-breaker/circuit-breaker.service.ts`
    (`BREAKER_COUNT_REFUSALS_ENV = 'EVER_JOBS_BREAKER_COUNT_REFUSALS'`,
    `readBreakerCountRefusals(env)`, `refusedEmptyResult(result)`, `exec`),
    `packages/plugin/src/circuit-breaker/__tests__/circuit-breaker.service.spec.ts`
  - **Gaps:** K2
  - **Acceptance:** after `fn` resolves, a result shaped `{ jobs: [], diagnostics: { reason:
    'rate_limited' | 'blocked' } }` calls `onFailure` with a synthetic error (spec §7.6) and
    is returned unchanged; anything else → `onSuccess` as today; half-open probes follow
    the same rule; the switch is read at construction (like `EVER_JOBS_CIRCUIT_MAX_SITES`).
  - **Tests:** 5 refused results → `open`, the 6th call short-circuits; `blocked` likewise;
    `fetch_error`, `partial` with jobs, `rate_limited` with 3 jobs → no failure.
    **Red control:** `EVER_JOBS_BREAKER_COUNT_REFUSALS=false` → stays `closed`.
  - **Estimate:** 0.25 day

- [x] T16 — [API] Liveness trusts a fresh plugin fetch
  - **Files:** `apps/api/src/jobs/jobs.controller.ts` (request start time,
    `enrichLiveness(jobs, trustSince?)`), `apps/api/src/jobs/crawl-policy.mapping.ts`
    (`LIVENESS_TRUST_FRESH_FETCH_ENV`, `livenessTrustFreshFetch(env)`),
    `apps/api/src/jobs/__tests__/jobs.controller.crawl.spec.ts`
  - **Gaps:** G4, G28
  - **Acceptance:** `requestStartedAt` taken before the search-cache lookup; on a fresh
    fan-out (not a cache hit) a job whose `Date.parse(jobUrlFetchedAt) >= requestStartedAt`
    gets `liveness = { state: 'active', checkedAt: jobUrlFetchedAt, reason:
    JOB_LIVENESS_REASON_FRESH_FETCH }` and its URL is not passed to `checkBatch`; the rest
    are probed in order; probe verdicts keep today's shape (no `reason`).
  - **Tests:** 3 jobs (fresh, stale, none) → `checkBatch` receives 2 URLs; cache hit → 3.
    **Red control:** `EVER_JOBS_LIVENESS_TRUST_FRESH_FETCH=false` → 3 URLs probed.
  - **Estimate:** 0.25 day

- [x] T17 — [API] Liveness probes of Softy tenants share the Softy bucket and proxy
  - **Files:** new `packages/plugins/liveness-http/__tests__/liveness-http.host-policy.spec.ts`
    (no source change in `liveness-http`)
  - **Gaps:** G2, G4, G11, G28
  - **Acceptance:** with `axios.defaults.adapter` replaced by a recording fake (no
    network), env proxies `p1..p4`, a fresh `HostLimiter` and `runWithScrapeContext({ site:
    'liveness-http' })`: `checkBatch` over 2 URLs on `a.softy.pro` and 2 on `b.softy.pro`
    (5 workers; the fake answers after 700 ms, so the idle gap, not the interval, decides
    each next start) never has 2 in flight, starts ≥ 975 ms apart, idle ≥ 475 ms, one proxy
    for all, the limiter's only bucket is `domain:softy.pro`.
  - **Red control:** `EVER_JOBS_CRAWL_BUILTIN_HOSTS=false` → two `host:` buckets, overlap,
    two proxies.
  - **Estimate:** 0.25 day

## Phase 2 — Documentation

- [x] T18 — [CORE] Operator guide
  - **Files:** `docs/CRAWL_POLICY.md`
  - **Acceptance:** new fields in §2/§5.1/§9 (`minGapMs`, `serverErrorCooldownMs`); new
    switches in §5.2 with the value that restores pre-1714; §6 "Host-owned policies"
    (builtin patterns, the `*.softy.pro` entry, how an operator overrides it); §7.2 the
    lock (effective mode rule, provenance, both comparator columns, `requestTimeout`,
    caller proxies); §9 fleet size; §11 server-error cool-down; §12 robots back-off; §14
    Softy section rewritten from Spec 1715 (fallback modes, push-back table, caches,
    `SOFTY_*` variables, `SOFTY_LEGACY` tokens); §15 breaker and liveness changes; §16
    how to restore the pre-1714 behaviour. No competitor project named.
  - **Estimate:** 0.5 day

- [x] T19 — [API] Changelog, log, index, questions, env example
  - **Files:** `docs/API_CHANGELOG.md`, `docs/log.md` (newest first), `docs/index.md`
    (rows for Specs 1714 and 1715, operator-guide row text), `docs/questions.md`
    (Q-120..Q-125 at the top, spec §9 text with options and defaults), `.env.example`
    (every new `EVER_JOBS_*` and `SOFTY_*` variable of both specs, commented with default
    and restore value)
  - **Acceptance:** `npm run lint:docs` clean (the two new spec folders reachable from
    `docs/index.md`); changelog lists: new crawl fields, the Softy lock (callers can no
    longer make Softy traffic less polite; how an operator undoes it), `requestTimeout`
    gating, caller proxies under a lock, policy API meta, `jobUrlFetchedAt` and
    `liveness.reason`, breaker and multi-location changes, every restore switch.
  - **Estimate:** 0.5 day

## Phase 3 — Integration verification (orchestrator; no lane files)

- [ ] T20 — Verify the three lanes together
  - **Files:** `.specify/specs/1714-*/{spec,tasks}.md` (status, As built)
  - **Acceptance:** `npx tsc -p tsconfig.typecheck.json --noEmit` clean; `npm run
    test:core`; `npm run test:sources` for Softy, liveness-http and every suite that
    reaches `*.softy.pro`; `npm run test:scripts`; `npm run lint:docs`; every red control
    above reported with command and result; gap coverage table (below) confirmed. Since
    2026-09-27 it also covers Phase 4 (round 2) and its finding table.
  - **Estimate:** 0.5 day

## Phase 4 — Review round 2 (2026-09-27)

A review of the landed work (findings A0–A5, C0–C3, F0–F8; the refuted ones — F0, F1 except
its doc / meta core, F2 / C2, F6, A2, A4 — are not fixed) confirmed the items below. Lanes
as before (CORE, API, SOFTY in [Spec 1715](../1715-softy-audit-hardening/tasks.md), DOCS).
Each behaviour fix has a test and a red control run by its lane (the control fails on the
old code or under the legacy switch).

- [x] T21 — [CORE] Redirect hops paced by the hop's own policy (FR-19, finding A0)
  - **Files:** `packages/common/src/http/http-client.ts` (`DeferredRedirect`, per-attempt
    `pacedRedirectHook`, `followDeferredRedirect`, `DEFAULT_MAX_REDIRECTS`),
    `packages/common/src/http/crawl/{env,resolve,scrape-context}.ts` (`PACE_REDIRECTS`,
    `crawlPaceRedirectsEnabled`, `isPolicyOwnedHost`, `resolveCrawlInContext`), new
    `packages/common/__tests__/http-client-redirect-pacing.spec.ts`,
    `http-client-redirects.spec.ts`, `crawl-caller-lock.spec.ts`
  - **Acceptance:** a hop to another bucket, or to a host-owned policy, gets its own slot
    (≥ 1000 ms after the first grant under the builtin Softy policy), its origin's
    robots.txt, lock, proxy and retries; the guards run first; method / headers / `auth`
    change as follow-redirects would; the chain is capped at `maxRedirects ?? 21`;
    `maxRedirects: 0` untouched; same-bucket ordinary hops stay in the slot.
  - **Red control:** `EVER_JOBS_CRAWL_PACE_REDIRECTS=false` → one slot, the hop < 1000 ms
    after the grant, a robots-disallowed hop fetched; `legacy` preset → one slot.

- [x] T22 — [CORE] `EVER_JOBS_CRAWL_BUILTIN_HOSTS_DISABLE` (FR-20, finding F3)
  - **Files:** `packages/common/src/http/crawl/{env,resolve}.ts`,
    `packages/common/__tests__/{crawl-env,crawl-caller-lock}.spec.ts`
  - **Acceptance:** `*.softy.pro,softy.pro` → other plugins get the generic limits and no
    lock (noted in `notes`, listed in `builtinHostPatternsDisabled`), Greenhouse keeps 16 /
    0 ms, the Softy manifest stays; unknown patterns warned and ignored; the whole-layer
    switch still wins.
  - **Red control:** the same Greenhouse case under `EVER_JOBS_CRAWL_BUILTIN_HOSTS=false`
    reads 4 / 100 ms (the only switch before).

- [x] T23 — [CORE + API] The `legacy` preset restores the new switches (FR-21, finding F7)
  - **Files:** `packages/common/src/http/crawl/env.ts`,
    `apps/api/src/jobs/crawl-policy.mapping.ts` (`crawlPresetIsLegacy`),
    `packages/plugin/src/circuit-breaker/circuit-breaker.service.ts`, tests
    `crawl-env.spec.ts`, new `apps/api/src/jobs/__tests__/crawl-policy.switches.spec.ts`,
    `circuit-breaker.refusals.spec.ts`
  - **Acceptance:** unset under `legacy`: `1690` / `bucket` / `false` / `false` and the four
    API switches at their pre-1714 values; `polite` / `strict` unchanged; explicit values
    win; accessors follow the preset on hand-built configs.
  - **Red control:** an explicit value under `legacy` (e.g. `EVER_JOBS_BREAKER_COUNT_REFUSALS=true`
    → the breaker opens again).

- [x] T24 — [API] Invalid API switch values warn once (FR-22, finding F8)
  - **Files:** `apps/api/src/jobs/crawl-policy.mapping.ts` (`warnInvalidSwitchOnce`,
    `resetSwitchWarnings`), `circuit-breaker.service.ts` (`onInvalid(raw, used)`),
    `crawl-policy.switches.spec.ts`
  - **Acceptance:** one log line per variable and value, naming the value used; never throws.

- [x] T25 — [CORE] A caller's timeout gated per request host, never a struggling server (FR-23, finding C0 — `HttpClient` half)
  - **Files:** `packages/common/src/http/http-client.ts` (`timeoutPlan`,
    `isCallersShortTimeout`, `timeoutFromCaller`), `packages/common/src/http/crawl/types.ts`
    (`ScrapeContext.callerRequestTimeout`), `http-client-crawl-policy.spec.ts`
  - **Acceptance:** an unlocked plugin carrying the caller's 0.001 s → 60 s to
    `acme.softy.pro`, 1 ms elsewhere; no cool-down of `domain:softy.pro` from the caller's
    abort; a plugin's own timeout untouched; the robots.txt fetch gated too.
  - **Red control:** `EVER_JOBS_CRAWL_STRICTER_RULES=1690` → 1 ms abort, `softy.pro` cools 30 s.

- [x] T26 — [API] `JobsService` fills `ScrapeContext.callerRequestTimeout` (FR-23, finding C0 — wiring). `apps/api/src/jobs/jobs.service.ts` `scrapeOne`; end-to-end test `apps/api/src/jobs/__tests__/jobs.service.caller-timeout-host.spec.ts` (jsonld → `*.softy.pro` with 0.001 s → 60 s on the wire; unlocked host unchanged; `STRICTER_RULES=1690` ungated). Red control: without the wiring the Softy case sends 1 ms.
  - **Found by:** the round-2 docs pass. `JobsService.scrapeOne` builds the scrape context
    without it, and the JSON-LD plugin (like any plugin that copies `requestTimeout` into
    its own `timeout` option) builds its client from an object literal, so on the search
    API T25 recognises only clients built from the DTO. The C0 scenario (`siteType:
    ["jsonld"]`, a Softy `companyUrl`, `requestTimeout: 0.001`) is therefore still open on
    a default install.
  - **Files:** `apps/api/src/jobs/jobs.service.ts` (the `scrapeContext` of `scrapeOne`),
    a test in `apps/api/src/jobs/__tests__/jobs.service.crawl.spec.ts`
  - **Acceptance:** the context carries the `requestTimeout` handed to the plugin when the
    caller sent one (unset otherwise, so an ungated source's context is unchanged); an
    end-to-end test through `JobsService` with a JSON-LD-like plugin and a Softy URL shows
    60 s on the wire and no cool-down.
  - **Red control:** without the field → 1 ms on the wire and a 30 s cool-down.

- [x] T27 — [CORE] The base-scope proxy pin only under a lock (FR-24, finding C3)
  - **Files:** `packages/common/src/http/http-client.ts`,
    `packages/common/src/http/crawl/scrape-context.ts` (`builtinHostPatterns`),
    `http-client-crawl-policy.spec.ts`, `crawl-scrape-context.spec.ts`
  - **Acceptance:** Softy tenants share one proxy even with callers unlocked by the
    operator; an unlocked source under a `domain` base scope keeps the pre-1714 pick for
    every golden case; Greenhouse keeps the bucket pick.
  - **Control:** the golden expectations are the pre-1714 picks (the stable hash of the
    request's bucket key), which the round-1 code did not give for a `domain` base scope
    under `any` (finding C3).

- [x] T28 — [CORE + API] `jobUrlListedAt` and the `listed` liveness trust (FR-25, finding A3 — shared half)
  - **Files:** `packages/models/src/dtos/job-post.dto.ts`,
    `apps/api/src/jobs/{jobs.controller,crawl-policy.mapping}.ts`,
    `apps/api/src/config/configuration.ts`, `tool_manifest.json`, tests
    `job-post-board-fields.spec.ts`, `tool-manifest.spec.ts`, new
    `jobs.controller.liveness-listed.spec.ts` and `jobs.controller.liveness-trust-paths.spec.ts`
  - **Acceptance:** JSON and NDJSON: fresh listing trusted, stale probed, operator bound,
    cache hit trusted while young, future / unparseable probed, fresh fetch wins, trusted
    jobs outside the probe cap, liveness disabled withholds all.
  - **Red control:** `EVER_JOBS_LIVENESS_TRUST_LISTED_MAX_AGE_MS=0` → every job probed.

- [x] T29 — [API] Policy API meta: `builtinHostsDisabled`, `clientMinIntervalFloorMs` (FR-26, findings F3, F5)
  - **Files:** `apps/api/src/jobs/health.controller.ts`,
    `packages/plugin/src/interfaces/plugin-metadata.interface.ts`,
    `sources-crawl-policy.controller.spec.ts`
  - **Acceptance:** `[]` by default; the disabled list; the declared floor or `null`. The
    Softy plugin's own declaration is Spec 1715 T22 (open).

- [x] T30 — [API] Liveness timing test that needs the 1 s interval (FR-27, finding C1 — liveness half)
  - **Files:** `packages/plugins/liveness-http/__tests__/liveness-http.host-policy.spec.ts`
  - **Acceptance:** 20 ms answers, starts ≥ 1000 ms apart and idle ≥ 980 ms; the misleading
    comment on the key test corrected.
  - **Red control:** operator `hosts["*.softy.pro"] {minIntervalMs: 0}` (gap kept) → starts
    exactly 520 ms apart.

- [x] T31 — [API] The flaky floor test measures the limiter's grants (FR-27)
  - **Files:** `apps/api/src/jobs/__tests__/jobs.service.plugin-crawl.spec.ts`
  - **Acceptance:** of the two diagnoses, the first held: the requests were stamped in the
    mocked adapter after the async interceptor chain, while the limiter's grants were never
    closer than the floor. The test records the real `HostLimiter`'s grant instants and
    asserts the floors on them with no slack (`CLOCK_SLACK_MS` removed), plus one grant per
    wire request so a rename cannot make it pass vacuously. The limiter is unchanged.
  - **Evidence:** failing runs read 987 / 988 / 994 ms on loaded Linux runners (main run
    36238701455; PR #101 runs 36245459464, 36249571368); the adapter gap read up to 13 ms
    under the grant gap there, up to 52 ms under a CPU burner on Windows.

- [x] T32 — [DOCS] Round-2 docs
  - **Files:** `docs/CRAWL_POLICY.md` (§1, §2, §3, §4, §5.2, §5.4, §6.4, §7.2, §9, §10,
    §11, §12, §13, §14, §15, §16, §17, §18, §19, §21), `README.md`, `.env.example`,
    `docs/API_CHANGELOG.md`, this spec and tasks, Spec 1715 spec and tasks,
    `docs/log.md`, `docs/index.md`
  - **Acceptance:** every new switch with its default and `legacy` value; §16 "All of it"
    rewritten (what `legacy` restores and what it does not); the pre-1715 Softy recipe;
    `SOFTY_LEGACY=no-interval-floor` in every undo-the-lock recipe; the §6.4 note on
    builtin host entries over env-global; restore rows use
    `EVER_JOBS_CRAWL_BUILTIN_HOSTS_DISABLE`; `npm run lint:docs` clean.

### Finding coverage (round 2)

| Finding | Closed by | Note |
|---|---|---|
| A0 | T21, Spec 1715 T18 | Softy's own legacy detail URLs in 1715 |
| A1 | Spec 1715 T16 | |
| A3 | T28, Spec 1715 T19 | |
| A5, F4 | Spec 1715 T17 | |
| C0 | T25, T26 | per-host gate + `JobsService` wiring |
| C1 | T30, Spec 1715 T20 | |
| C3 | T27 | |
| F3 | T22, T29 | |
| F5 | T29, T32, **Spec 1715 T22 (open)** | recipe and §6.4 note; Softy's floor declaration open |
| F7 | T23, T32 | |
| F8 | T24 | |
| flaky timing test | T31 | |

## Gap coverage

| Gap | Closed by | Note |
|---|---|---|
| G0 | T02, T03, T04 | lock + identity comparators |
| G2, G11 | T03, T17 | builtin `*.softy.pro` applies to liveness |
| G3 | T03, T04 (+ Spec 1715 floor) | |
| G4, G28 | T03, T16, T17 | host policy + fresh-fetch trust |
| G5 | T04 | scope containment |
| G7 | T02, T06 (+ Spec 1715 `minGapMs: 500`) | |
| G8 | T03 | `*.softy.pro` and `softy.pro`; a tenant's own custom domain is not knowable |
| G9 | T03, T04, T05, T07, T13 | rotation order + caller proxies |
| G10 | T04, T07 | scope containment + pin on base scope |
| G12 | T03, T04 | |
| G14 | T02, T08 (+ Spec 1715 manifest) | |
| G15, G27 | T02, T08 | fleet multiplier; shared cool-down is Q-122 |
| G16 | T09 | |
| G17 | T10, T14 (+ Spec 1715 run.error) | |
| G18 | T08 | |
| G22 | T04 (+ Spec 1715 operator sitemap) | |
| G29 | T03, T13 | Softy part; prod env is Q-124 |
| K2 | T15 | |
| K3 | T02, T13 | |

## Notes

- Write tests alongside each implementation task; do not batch testing into a final task.
- No test touches the network (local servers on 127.0.0.1 through
  `EVER_JOBS_CRAWL_EGRESS_ALLOW_HOSTS`, axios adapter fakes, or fake clients).
- Every changed default keeps the old behaviour behind the switch named in its task; the
  switch is named in a code comment at the switch, in `docs/CRAWL_POLICY.md` and in the
  changelog.
- Never name any competitor project in code, comments, commits or docs.
- Lanes do not commit, push, stash, reset or check out; files LF, no BOM.
