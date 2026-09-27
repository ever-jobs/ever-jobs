# Spec: 1714 — Crawl policy: site-owner caller lock, host-owned policies, gentler pacing knobs

| Field | Value |
|---|---|
| Spec ID | 1714 |
| Slug | crawl-caller-lock-and-host-policies |
| Status | in-progress |
| Owner | agent |
| Created | 2026-09-26 |
| Last updated | 2026-09-26 |
| Supersedes | — |
| Related specs | 1690 (crawl policy), 1691 (Softy sitemap discovery), 1715 (Softy audit hardening, the plugin half of this work), 005 (circuit breaker), 721 / 740 (liveness), 1700 (multi-location search) |
| Plan / tasks | [plan.md](./plan.md) · [tasks.md](./tasks.md) |
| Operator guide | [docs/CRAWL_POLICY.md](../../../docs/CRAWL_POLICY.md) |
| Audit gaps closed | G0, G2, G3, G4, G5, G7, G8, G9, G10, G11, G12, G14, G15 (part), G16, G17, G18, G22 (part), G27, G28, G29 (part), K2, K3 |

## 1. Problem Statement

The operator of the Softy ATS (`*.softy.pro`, one shared server for every client
tenant) asked for five things: (A) an honest User-Agent naming the project, (B) one
request at a time, about 1 request per second, per site, (C) no proxy rotation,
(D) back-off on 429 / `Retry-After` and when the server struggles (5xx), never a faster
retry, and (E) discovery from `/sitemap.xml` rather than list pages. Specs 1690 and 1691
made the defaults meet all five. An audit on 2026-09-26 (35 confirmed gaps, ids G0..G30
and K0..K3) found paths that still break them. The ones in the shared crawl layer and
the API are this spec; the ones inside the Softy plugin are Spec 1715.

The core problems:

1. **The API caller can undo the site owner's request.** On a default install
   `EVER_JOBS_CRAWL_CALLER_OVERRIDES` is `any` and API-key auth is off, so an anonymous
   `POST /api/jobs/search` can send a browser UA (G0), drop the 1 s interval and the
   concurrency cap (G3), rotate proxies per request (G9), switch off `Retry-After`
   respect and the throttle floor (G12), choose list pages (G22), or make requests
   overlap on the server through a tiny `requestTimeout` (K3). Our production accepts
   the same (G29).
2. **`stricter` is not stricter.** `rateLimitScope: 'site'` next to a `domain` bucket
   creates a second, parallel bucket (G5); `proxyRotation` treats `off` and `per-host` as
   equal and the per-host proxy pick follows whatever bucket a caller chose (G10);
   `retryStatuses` may drop 429/503 handling; `discovery` is always accepted.
3. **Politeness is tied to the plugin, not the host.** Liveness probes (`?liveness=true`),
   the JSON-LD plugin, or any other code path that reaches `*.softy.pro` runs under the
   generic defaults — 4 in flight, 100 ms, a per-tenant bucket and proxy (G2, G4, G8,
   G11, G28). `BUILTIN_HOST_POLICIES` only matches exact hosts.
4. **Pacing knobs are missing.** The interval is start-to-start, so a slow server gets
   back-to-back requests (G7); 500/502/504 and timeouts cause no back-off at all (G14);
   every process paces on its own, so N replicas send N times the budget (G15, G27);
   a robots.txt 429 / `Retry-After` is ignored (G18); a nested sitemap's 429 is swallowed
   and the walk continues (G16).
5. **The API does not recognise push-back.** A multi-location search keeps asking a
   source that answered 503 (G17); the circuit breaker never trips for a plugin that
   turns its failures into a resolved, empty response with a `rate_limited` / `blocked`
   diagnostic (K2); liveness re-fetches the detail pages the plugin has just read (G4,
   G28).

## 2. Goals

- G1 A plugin manifest or a builtin host policy can **lock** what a search caller may
  change (`callerOverrides`), so a site owner's request survives a default install. The
  operator can still loosen or tighten it per site or host.
- G2 `stricter` means stricter for every field: no parallel buckets, no more rotation, no
  identity change, no weaker back-off, no list pages instead of the sitemap, no shorter
  timeouts, no caller proxies.
- G3 Host-owned policies: a builtin policy for `*.softy.pro` applies to every request to
  those hosts, whichever plugin or pseudo-site makes it.
- G4 New pacing knobs: an idle gap after completion (`minGapMs`), a whole-bucket
  cool-down after server errors (`serverErrorCooldownMs`), and a fleet-size multiplier.
- G5 The API stops on push-back (503 in multi-location loops, refused empty results in
  the breaker) and does not re-probe pages a plugin has just fetched.
- G6 **No removal, maximum flexibility** (owner rules): every changed default keeps the
  old behaviour behind a named switch; sources without a lock behave byte for byte as
  before under the default `any`.

## 3. Non-Goals

- Sharing limiter state or cool-downs across processes (Valkey-backed buckets). The
  fleet-size multiplier is the configuration answer here; the shared state is a
  follow-up (Q-122).
- Changing the global default `EVER_JOBS_CRAWL_CALLER_OVERRIDES` (stays `any`), or the
  global defaults of any source other than Softy.
- Deployment changes in `k8s-gitops` (contact / `From` in prod, API-key auth,
  `EVER_JOBS_CRAWL_CALLER_PROXIES` there) — owner / infra items (Q-124).
- The Softy plugin's own behaviour (sitemap fallback, push-back, caches, CI): Spec 1715.

## 4. User / Caller Stories

> As a **site operator** (Softy), I want the pace and identity I asked for to hold
> whoever calls the Ever Jobs API, so that one anonymous request cannot undo it.

> As the **Ever Jobs operator** (whoever runs an install), I want every behaviour to stay
> configurable, including loosening a site's lock when I have the site's agreement, so
> that the software never decides for me.

> As an **API caller**, I want to make my own requests more polite (slower, fewer
> retries, the honest UA, the sitemap), so that I can be a better citizen than the
> defaults; I accept that I cannot make a locked site's traffic less polite.

> As an **operator running N replicas behind one egress IP**, I want one setting that
> keeps the aggregate pace within a site's policy.

## 5. Functional Requirements

| ID | Requirement | Gaps | Priority |
|---|---|---|---|
| FR-1 | New optional `callerOverrides?: 'any' \| 'stricter' \| 'none'` on `CrawlPolicyOverride` (so on `PluginCrawlPolicy`, builtin host entries, operator `sites` / `hosts` and the policy file). It is a *lock*, not a policy value: never copied into the resolved `CrawlPolicy`, and always refused from a caller (listed in `callerRejected`). | G0, G3, G9, G12 | must |
| FR-2 | Effective caller mode for a request = the most restrictive (`none` > `stricter` > `any`) of the global env mode, the plugin layer's `callerOverrides` (manifest when `EVER_JOBS_CRAWL_PLUGIN_MANIFESTS` is on, plus the plugin's client `crawl` option) and every matching builtin-host pattern's — unless an operator layer sets `callerOverrides` for that site or host, in which case the operator value wins outright, looser or tighter (an operator host pattern's value beats the operator site value; among host patterns the most specific one that sets it wins). The caller layer of `resolveCrawlPolicy` is filtered with the effective mode. | G0, G3, G9, G12, G22 | must |
| FR-3 | `GET /api/sources/:site/crawl-policy` shows the effective mode and where it came from: `meta.callerOverrides` (effective), `meta.callerOverridesProvenance` (`default` \| `env-global` \| `builtin-host` \| `plugin` \| `operator-site` \| `operator-host`), `meta.globalCallerOverrides`, `meta.builtinHostPatterns`, `meta.fleetSize`. | G0 | must |
| FR-4 | `stricter` comparators (rules `1714`, default): see §7.3. `EVER_JOBS_CRAWL_STRICTER_RULES=1690` restores the Spec 1690 comparators (and leaves `requestTimeout` ungated). | G3, G5, G10, G12, G22 | must |
| FR-5 | Caller-supplied `proxies` are ignored when the effective caller mode is not `any` because of a lock or an operator per-site/host value (operator env proxies still apply). Rule (`crawlCallerProxiesAllowedFor`): source `default` / `env-global` → `EVER_JOBS_CRAWL_CALLER_PROXIES` decides exactly as before; source `plugin` / `builtin-host` → allowed only when the mode is `any` **and** `EVER_JOBS_CRAWL_CALLER_PROXIES` allows it (a lock never loosens the operator's proxy setting); source `operator-site` / `operator-host` → allowed exactly when the operator's value is `any` (per-site flexibility). Applied per plugin in `JobsService.scrapeOne` and per host in `HttpClient` (for any plugin that reaches a locked host). | G9, G29 | must |
| FR-6 | The `per-host` proxy pick keys on the registrable domain whenever the base scope (the scope resolved without the caller) is `domain`, so two tenants of one site never exit through different proxies because of a caller setting. `EVER_JOBS_CRAWL_PROXY_PIN_SCOPE=bucket` restores the pre-1714 pick (the request's bucket). | G10, G11 | must |
| FR-7 | `requestTimeout` (flat DTO field, seconds): under effective mode `stricter` only a value ≥ the resolved default (60 s) is accepted, otherwise the default is used; under `none` it is ignored (default used); under `any` it passes unchanged. Helper `gateCallerRequestTimeout` exported from `@ever-jobs/common`; `apps/api` applies it once per source in `JobsService.scrapeOne`, which the REST, GraphQL, MCP (via REST) and CLI paths all reach. | K3 | must |
| FR-8 | `BUILTIN_HOST_POLICIES` keys accept `*.suffix` (and exact hosts), matched with the operator `hosts` semantics (`*.x` = any subdomain, not the apex); every matching pattern applies, least specific first. New entries `*.softy.pro` and `softy.pro` = `BUILTIN_SOFTY_HOST_POLICY` (§7.1). Operator `sites` / `hosts` entries still override them; `EVER_JOBS_CRAWL_BUILTIN_HOSTS=false` switches the layer off (as before). | G2, G4, G8, G11, G28 | must |
| FR-9 | New policy field `minGapMs` (default 0 = today): after a request of the bucket completes, the next one starts no sooner than `minGapMs` later, in addition to `minIntervalMs` start-to-start. Env `EVER_JOBS_CRAWL_MIN_GAP_MS`. | G7 | must |
| FR-10 | New policy field `serverErrorCooldownMs` (default 0 = today): when a request of the bucket ends in 500, 502 or 504, a timeout or a connection reset, the whole bucket cools down this long (like a throttle, but for "struggling"). Env `EVER_JOBS_CRAWL_SERVER_ERROR_COOLDOWN_MS`. Applies to thrown answers, answers accepted through `validateStatus`, and browser navigations (`recordAnswerOutcome`). | G14 | must |
| FR-11 | `EVER_JOBS_CRAWL_FLEET_SIZE` (env only, integer 1..1000, default 1): each process multiplies its start-to-start spacing (`max(minIntervalMs, Crawl-delay, the client's minIntervalFloorMs)`) and `minGapMs` by it, so N processes sharing one egress stay within the policy. Shown in the policy API meta. | G15, G27 | must |
| FR-12 | robots.txt answers feed the limiter like any request: a 429/503 throttles and cools the bucket, a `Retry-After` over `maxRetryAfterMs` cools it for the full time and fails the page request with `HostCoolingDownError`; a 5xx applies `serverErrorCooldownMs`. `EVER_JOBS_CRAWL_ROBOTS_BACKOFF=false` restores pre-1714 (the answer never touches the limiter). | G18 | must |
| FR-13 | `fetchSitemap` option `nestedErrors?: 'stop-on-throttle' \| 'skip'` (default `stop-on-throttle`): a nested sitemap answering 429/503, or failing with a crawl-policy error (`HostCoolingDownError`, `CrawlQueueTimeoutError`, `EgressBlockedError`, `RobotsDisallowedError`), stops the walk and the error is rethrown. `skip` = pre-1714 (report to `onError`, continue). | G16 | must |
| FR-14 | Multi-location loop: `rate_limited`, `blocked` and a 503-caused `fetch_error` stop the remaining locations for that site. `EVER_JOBS_SEARCH_STOP_ON_503=false` restores pre-1714 for 503. The precedence rule "a throttle/refusal diagnostic wins over an earlier plain 5xx" is provided as `preferRefusalError` in `@ever-jobs/models` for plugins (Softy uses it, Spec 1715). | G17 | must |
| FR-15 | Circuit breaker: a resolved scrape with 0 jobs whose diagnostic is `rate_limited` or `blocked` counts as a failure (the result is still returned). `EVER_JOBS_BREAKER_COUNT_REFUSALS` (default true; false = today). | K2 | must |
| FR-16 | Liveness: probes run under the host policy automatically (FR-8). Additionally, a job whose `jobUrlFetchedAt` (new optional field, §7.4) is not older than the start of this request is marked `liveness: { state: 'active', checkedAt: <jobUrlFetchedAt>, reason: 'fresh-fetch' }` and not probed; a search-cache hit never counts as fresh. `EVER_JOBS_LIVENESS_TRUST_FRESH_FETCH` (default true; false = probe every URL, as today). | G4, G28 | must |
| FR-17 | Sources without a lock: under the default `any`, `explainCrawlPolicy` gives the same policy (1690 fields), provenance and `callerRejected` as before this spec (golden test). | — | must |
| FR-18 | Docs: `docs/CRAWL_POLICY.md` (new fields, lock semantics, fleet size, host policies, Softy section), `docs/API_CHANGELOG.md`, `docs/log.md`, `docs/index.md`, `docs/questions.md` (Q-120..Q-125), `.env.example`, `tool_manifest.json`. `npm run lint:docs` passes. | — | must |

## 6. Non-Functional Requirements

| ID | Requirement | Target |
|---|---|---|
| NFR-1 | Policy resolution stays memoised per (env, plugin, caller) leaf; the lock and builtin pattern matching add no per-request work beyond a memo miss | resolution cost per request unchanged (memo hit) |
| NFR-2 | No test touches the network: local HTTP servers on 127.0.0.1 (egress allow-list) or fakes / axios adapters only | 0 external hosts |
| NFR-3 | Every new env value is validated; an invalid value warns once and falls back to the default, never throws | as Spec 1690 §5.1 |
| NFR-4 | LF line endings, no BOM, in every touched file | — |

## 7. Contracts

These names are the contract between the three implementation lanes (plan §3). They
must not be renamed.

### 7.1 Types and constants (`@ever-jobs/common`, `packages/common/src/http/crawl/`)

```ts
// types.ts
export interface CrawlPolicy {
  // ... every Spec 1690 field, unchanged ...
  /**
   * Minimum idle time, ms, after a request of the bucket COMPLETES before the next one
   * starts — on top of `minIntervalMs` (start to start). 0 = none (pre-1714).
   * Env EVER_JOBS_CRAWL_MIN_GAP_MS. Multiplied by EVER_JOBS_CRAWL_FLEET_SIZE.
   */
  minGapMs: number;
  /**
   * Whole-bucket cool-down, ms, after a request ends in 500/502/504, a timeout or a
   * connection reset. 0 = off (pre-1714). Env EVER_JOBS_CRAWL_SERVER_ERROR_COOLDOWN_MS.
   */
  serverErrorCooldownMs: number;
}

/** A partial policy plus the caller-override lock (Spec 1714). */
export type CrawlPolicyOverride = Partial<CrawlPolicy> & {
  /**
   * What a search caller may change for requests this layer covers. Valid in plugin
   * manifests, builtin host policies and operator sites/hosts; never accepted from a
   * caller; never part of the resolved `CrawlPolicy`.
   */
  callerOverrides?: CallerOverridePolicy;
};

export type CallerOverridesSource =
  | 'default' | 'env-global' | 'builtin-host' | 'plugin' | 'operator-site' | 'operator-host';

export interface CallerOverridesResolution {
  /** The effective mode the caller layer is filtered with. */
  mode: CallerOverridePolicy;
  /** The layer that decided `mode` (on a tie, the highest layer asking for it). */
  source: CallerOverridesSource;
  /** EVER_JOBS_CRAWL_CALLER_OVERRIDES (or its default `any`). */
  global: CallerOverridePolicy;
}

// defaults.ts
// POLITE / LEGACY / STRICT presets gain minGapMs: 0, serverErrorCooldownMs: 0.
export const BUILTIN_SOFTY_HOST_POLICY: CrawlPolicyOverride = {
  rateLimitScope: 'domain', maxConcurrentPerHost: 1, minIntervalMs: 1000, minGapMs: 500,
  proxyRotation: 'per-host', retries: 1, retryStatuses: [429, 503],
  throttleRetryDelayMs: 10000, serverErrorCooldownMs: 30000,
  respectRetryAfter: true, retryAfterOverMax: 'give-up', callerOverrides: 'stricter',
};
// BUILTIN_HOST_POLICIES gains: '*.softy.pro': BUILTIN_SOFTY_HOST_POLICY,
//                              'softy.pro':   BUILTIN_SOFTY_HOST_POLICY
// CRAWL_ENV gains: MIN_GAP_MS: 'EVER_JOBS_CRAWL_MIN_GAP_MS',
//                  SERVER_ERROR_COOLDOWN_MS: 'EVER_JOBS_CRAWL_SERVER_ERROR_COOLDOWN_MS'

// env.ts — CRAWL_EXTRA_ENV gains:
//   FLEET_SIZE: 'EVER_JOBS_CRAWL_FLEET_SIZE'            (int 1..1000, default 1)
//   STRICTER_RULES: 'EVER_JOBS_CRAWL_STRICTER_RULES'    ('1714' default | '1690')
//   PROXY_PIN_SCOPE: 'EVER_JOBS_CRAWL_PROXY_PIN_SCOPE'  ('base' default | 'bucket')
//   ROBOTS_BACKOFF: 'EVER_JOBS_CRAWL_ROBOTS_BACKOFF'    (bool, default true)
// ParsedCrawlPolicyEnv gains fleetSize?, stricterRules?, proxyPinScope?, robotsBackoff?
export type CrawlStricterRules = '1714' | '1690';
export type CrawlProxyPinScope = 'base' | 'bucket';
export function crawlFleetSize(env: CrawlPolicyEnvConfig): number;            // missing → 1
export function crawlStricterRules(env: CrawlPolicyEnvConfig): CrawlStricterRules;
export function crawlProxyPinScope(env: CrawlPolicyEnvConfig): CrawlProxyPinScope;
export function crawlRobotsBackoffEnabled(env: CrawlPolicyEnvConfig): boolean;
/** FR-5: default/env-global → crawlCallerProxiesAllowed(env) (today); plugin/builtin-host →
 *  mode === 'any' && crawlCallerProxiesAllowed(env); operator-site/operator-host → mode === 'any'. */
export function crawlCallerProxiesAllowedFor(lock: CallerOverridesResolution, env: CrawlPolicyEnvConfig): boolean;

// caller-lock.ts (new module, exported from the crawl index)
export const CALLER_OVERRIDES_RANK: Readonly<Record<CallerOverridePolicy, number>>; // any 0, stricter 1, none 2
export function mostRestrictiveCallerOverrides(
  ...modes: Array<CallerOverridePolicy | undefined>
): CallerOverridePolicy | undefined;
export const DEFAULT_REQUEST_TIMEOUT_SECONDS = 60;
export interface CallerRequestTimeoutDecision {
  /** The timeout (seconds) to use; `requested` unchanged under `any`. */
  value: number | undefined;
  /** False when the caller's value was replaced by the default. */
  accepted: boolean;
  note?: string;
}
export function gateCallerRequestTimeout(
  requested: unknown,
  mode: CallerOverridePolicy,
  resolvedDefaultSeconds?: number,          // DEFAULT_REQUEST_TIMEOUT_SECONDS
  rules?: CrawlStricterRules,               // '1690' → pass-through (pre-1714)
): CallerRequestTimeoutDecision;

// resolve.ts
export function resolveCallerOverrides(
  input: CrawlPolicyResolveInput, env?: CrawlPolicyEnvConfig,
): CallerOverridesResolution;
export interface CrawlPolicyExplanation {
  // existing fields; `callerOverrides` now carries the EFFECTIVE mode
  callerOverrides: CallerOverridePolicy;
  callerOverridesSource: CallerOverridesSource;
  globalCallerOverrides: CallerOverridePolicy;
  /** Builtin host patterns applied, least specific first. `builtinHost` keeps its meaning. */
  builtinHostPatterns: string[];
  /** `rateLimitScope` as resolved before the caller layer (proxy pin, FR-6). */
  baseRateLimitScope: RateLimitScope;
}
export function filterCallerOverride(
  caller: CrawlPolicyOverride | undefined, base: CrawlPolicy, mode: CallerOverridePolicy,
  options?: { rules?: CrawlStricterRules },   // default '1714'
): { accepted: CrawlPolicyOverride; rejected: string[] };

// scrape-context.ts
export interface EffectiveCrawlResolution {
  policy: ResolvedCrawlPolicy;
  callerOverrides: CallerOverridesResolution;
  baseRateLimitScope: RateLimitScope;
}
export function getEffectiveCrawlResolution(host?: string, explicit?: CrawlPolicyOverride): EffectiveCrawlResolution;
// getEffectiveCrawlPolicy(host, explicit) keeps its signature and returns .policy
export function getEffectiveProxies(
  explicit?: readonly string[] | null,
  options?: { ignoreCallerProxies?: boolean },  // true → skip the scrape context's (caller) proxies
): string[];

// host-limiter.ts — HostLimiterAcquireExtraOptions gains:
//   minGapMs?: number   // applied when the granted request's release() runs
// proxy-selector.ts
export function proxyPinKeyFor(
  url: string, bucketScope: RateLimitScope, baseScope: RateLimitScope | undefined,
  site: string | undefined, pinScope?: CrawlProxyPinScope,   // default 'base'
): string;
// sitemap.ts — FetchSitemapOptions gains:
//   nestedErrors?: 'stop-on-throttle' | 'skip'   // default 'stop-on-throttle'
export function isSitemapStopError(err: unknown): boolean;  // 429/503 status or a CrawlPolicyError in the cause chain

// http-client.ts
export const SERVER_ERROR_STATUSES: ReadonlySet<number>;   // 500, 502, 504
/** 500/502/504, or (no response) a timeout / connection reset — never our own abort. */
export function isServerStruggling(status: number | undefined, err?: unknown): boolean;
// crawlAcquireOptions(policy, signal?, crawlDelayMs = 0, fleetSize = crawlFleetSize(readCrawlPolicyEnv()))
//   → minIntervalMs = max(policy.minIntervalMs, crawlDelayMs) × fleetSize, minGapMs = policy.minGapMs × fleetSize
// AnswerOutcome gains serverErrorCooldownMs?: number (set when recordAnswerOutcome applied FR-10)
// HttpClientOptions gains proxiesFromCaller?: boolean  (internal marker set by
//   clientOptionsFromScraperInput; such proxies are dropped for a locked host, FR-5)
```

`PluginCrawlPolicy extends CrawlPolicyOverride`, so `@SourcePlugin({ crawl: { callerOverrides } })`
type-checks with no change to `packages/plugin/src/interfaces/plugin-metadata.interface.ts`
beyond its doc comment.

### 7.2 `@ever-jobs/models`

```ts
// dtos/crawl-policy.dto.ts — CrawlPolicyDto gains (both @IsOptional @IsInt @Min(0)):
minGapMs?: number;
serverErrorCooldownMs?: number;
// CrawlPolicyDto does NOT gain callerOverrides (a caller cannot set a lock; the REST
// whitelist strips it, GraphQL/MCP do not declare it, the resolver refuses it).

// dtos/job-post.dto.ts
/** ISO-8601 UTC instant at which the source plugin itself fetched `jobUrl` and got a
 *  2xx page it could parse, during the scrape that produced this record. Unset when the
 *  page came from a plugin cache, was not fetched, or failed (Spec 1714 FR-16). */
jobUrlFetchedAt?: string | null;
liveness?: { state: 'active' | 'expired' | 'uncertain'; checkedAt?: string; reason?: string } | null;
export const JOB_LIVENESS_REASON_FRESH_FETCH = 'fresh-fetch';

// dtos/scrape-diagnostics.dto.ts
/** The error a scrape should report: `next` replaces `current` when `next` is a refusal
 *  or throttle (429, 503, 401/403/407, a challenge, a crawl-policy `rate_limited` /
 *  `blocked`) and `current` is not; otherwise the first error stays (G17). */
export function preferRefusalError(current: unknown, next: unknown): unknown;
```

### 7.3 `stricter` comparators (rules `1714`)

A caller value is accepted when it is at least as polite as the policy resolved without
the caller (`base`). An equal value is always accepted (a no-op). Changes from Spec 1690
in **bold**; `EVER_JOBS_CRAWL_STRICTER_RULES=1690` restores the 1690 column.

| Field | Rules `1714` (default) | Rules `1690` |
|---|---|---|
| `userAgent`, `from` | never (identity change) | same |
| `userAgentMode` | strict > identify > plugin (so under a Softy lock, base `identify`, only `strict` changes anything) | same |
| `rateLimitScope` | **equal, or `host` → `domain` only** (the new bucket must contain the base bucket; `site` next to `domain` is refused) | domain = site > host |
| `proxyRotation` | **off < per-host < per-scrape < per-request; accept ≤ base** | off = per-host > per-scrape > per-request |
| `maxConcurrentPerHost` | lower; 0 = unlimited (refused unless the base is 0) | same |
| `minIntervalMs`, `jitterMs`, `retryBaseDelayMs`, `retryMaxDelayMs`, `throttleRetryDelayMs`, **`minGapMs`, `serverErrorCooldownMs`** | higher or equal | same (the new fields: higher) |
| `retries` | lower | same |
| `retryStatuses` | **keeps every one of 429/503 that the base has; may drop other statuses; may add only 429/503** | a subset of base |
| `respectRetryAfter`, `adaptiveThrottle`, `stripClientHints`, `retryJitter`, `blockPrivateNetworks` | true | same |
| `retryOnNetworkError` | false | same |
| `retryAfterOverMax` | give-up > cap | same |
| `maxRetryAfterMs` | any under give-up; higher under cap | same |
| `retryBackoff` | exponential > linear > constant | same |
| `robotsTxt` | respect > crawl-delay > off | same |
| `maxQueueWaitMs` | any | same |
| `discovery` | **equal, or `sitemap`** | any |
| `callerOverrides` (not a field) | always refused | always refused |
| `requestTimeout` (DTO, FR-7) | ≥ 60 s under `stricter`; ignored under `none` | not gated |

`none` refuses every field; `any` accepts every field except that `blockPrivateNetworks`
may only be turned on (unchanged from 1690).

### 7.4 Environment

| Variable | Values (default) | Restores pre-1714 with |
|---|---|---|
| `EVER_JOBS_CRAWL_MIN_GAP_MS` | int ms (`0`) | `0` |
| `EVER_JOBS_CRAWL_SERVER_ERROR_COOLDOWN_MS` | int ms (`0`) | `0` |
| `EVER_JOBS_CRAWL_FLEET_SIZE` | int 1..1000 (`1`) | `1` |
| `EVER_JOBS_CRAWL_STRICTER_RULES` | `1714` \| `1690` (`1714`) | `1690` |
| `EVER_JOBS_CRAWL_PROXY_PIN_SCOPE` | `base` \| `bucket` (`base`) | `bucket` |
| `EVER_JOBS_CRAWL_ROBOTS_BACKOFF` | bool (`true`) | `false` |
| `EVER_JOBS_SEARCH_STOP_ON_503` | bool (`true`) | `false` |
| `EVER_JOBS_BREAKER_COUNT_REFUSALS` | bool (`true`) | `false` |
| `EVER_JOBS_LIVENESS_TRUST_FRESH_FETCH` | bool (`true`) | `false` |
| `EVER_JOBS_CRAWL_CALLER_OVERRIDES` | unchanged: `any` \| `stricter` \| `none` (`any`) | — |

The Softy lock itself is undone per install by an operator policy:
`{"sites":{"softy":{"callerOverrides":"any"}},"hosts":{"*.softy.pro":{"callerOverrides":"any"},"softy.pro":{"callerOverrides":"any"}}}`
(or, more bluntly, `EVER_JOBS_CRAWL_PLUGIN_MANIFESTS=false` and
`EVER_JOBS_CRAWL_BUILTIN_HOSTS=false`, which switch off every manifest / builtin host).

### 7.5 API

- `GET /api/sources/:site/crawl-policy[?host=&crawl=]`: the resolved policy (now with
  `minGapMs`, `serverErrorCooldownMs`) plus `meta.callerOverrides` (effective),
  `meta.callerOverridesProvenance`, `meta.globalCallerOverrides`,
  `meta.builtinHostPatterns`, `meta.fleetSize`. Everything else unchanged.
- `ScraperInputDto.crawl` / GraphQL `CrawlPolicyInput` / MCP `crawl` /
  `tool_manifest.json`: `minGapMs`, `serverErrorCooldownMs` (non-negative integers).
- Job JSON: optional `jobUrlFetchedAt`; `liveness.reason` (`fresh-fetch`) on jobs marked
  live from a fresh plugin fetch.
- Behaviour: caller fields refused by a lock come back in `?crawl=` previews as
  `meta.caller.rejected`; during a search they are dropped (logged once per search at
  warn level, as refused fields are today).

### 7.6 Errors and diagnostics

No new error class. FR-12 raises the existing `HostCoolingDownError` (its `status` = the
robots.txt answer). FR-15 records a synthetic failure `Error('<site>: resolved with 0 jobs
and diagnostic <reason>: <detail>')` as the breaker's `lastError`; the scrape's result
is returned unchanged.

## 8. Test Plan

Every key test gets a **red-control run**: the same test executed once with the legacy
switch (or, where there is none, a named one-line mutation) must fail for the stated
reason, then pass with the new default. Lanes report both runs (command + result).

| Test (lane) | Asserts | Red control |
|---|---|---|
| `packages/common/__tests__/crawl-caller-lock.spec.ts` (CORE, new) | Softy manifest lock under global `any` refuses `{userAgentMode:'plugin'}`, `{userAgent:'browser'}`, `{from}`, `{proxyRotation:'per-request'}`, `{rateLimitScope:'site'}`, `{minIntervalMs:0}`, `{maxConcurrentPerHost:0}`, `{respectRetryAfter:false}`, `{retries:10}`, `{retryStatuses:[500]}`, `{discovery:'listing'}`, `{minGapMs:0}`; accepts `{minIntervalMs:2000}`, `{userAgentMode:'strict'}`, `{discovery:'sitemap'}` | `EVER_JOBS_CRAWL_PLUGIN_MANIFESTS=false` → all accepted (the lock is gone) |
| same file | site `liveness-http`, host `acme.softy.pro`: `domain`/1/1000/500 ms, `callerOverrides` stricter from `builtin-host`; `softy.pro` apex too; `acme.softy.pro.evil.com` not matched | `EVER_JOBS_CRAWL_BUILTIN_HOSTS=false` → `host`/4/100 |
| same file | operator `sites.softy.callerOverrides:'any'` loosens, `hosts["*.softy.pro"]:'none'` tightens, host beats site; global `none` + plugin `stricter` = `none` (env-global) | remove the operator entry → plugin mode returns |
| same file | `gateCallerRequestTimeout` table (any/stricter/none × 0.2/60/120/undefined/NaN) | `rules: '1690'` → pass-through |
| `crawl-resolve.spec.ts` (CORE, updated) | the per-field table of §7.3 under `1714`, a second table under `1690` | run the `1714` table with `EVER_JOBS_CRAWL_STRICTER_RULES=1690` → the scope / rotation / statuses / discovery rows go red |
| `crawl-resolve.golden.spec.ts` (CORE, new) + fixture | FR-17: 12 non-Softy (site, host, caller) cases under `any` equal a golden JSON captured **before** the code change (1690 fields, provenance, `callerRejected`) | mutation: default the effective mode to `stricter` → golden red |
| `crawl-host-limiter.spec.ts` (CORE) | fake clock: 1 in flight, interval 1000, gap 500; request 1 granted t=0, released t=1500 → request 2 granted at t=2000 | `minGapMs: 0` → granted at t=1500 |
| `http-client-crawl-policy.spec.ts` (CORE) | 502 answer → bucket cooling 30 s, next request to the same bucket waits (fake limiter clock / snapshot); timeout (`ECONNABORTED`) and `ECONNRESET` too; our own abort does not | `serverErrorCooldownMs: 0` → no cool-down |
| same | `EVER_JOBS_CRAWL_FLEET_SIZE=3` → acquire options `minIntervalMs` 3000 (policy 1000), `minGapMs` 1500, and the client floor × 3 | fleet `1` → 1000 / 500 |
| same | robots.txt `429 Retry-After: 3600` under `robotsTxt: 'respect'`: 1 robots request, 0 page requests, `HostCoolingDownError`; `429` without Retry-After → bucket cools the throttle floor, page waits | `EVER_JOBS_CRAWL_ROBOTS_BACKOFF=false` → page request sent at once |
| same | proxies `p1..p4`, operator `sites.x.rateLimitScope:'domain'` + `callerOverrides:'any'`, caller `rateLimitScope:'host'`: `t1.x.example` and `t2.x.example` use the same proxy (FNV of `domain:x.example`) | `EVER_JOBS_CRAWL_PROXY_PIN_SCOPE=bucket` → different proxies |
| same | a DTO-branch client (`createHttpClient({ proxies: ['http://proxy9.example.net:8080'], requestTimeout: 60 })`, a public-looking name so the literal proxy egress check passes; the axios adapter fake never connects) inside a `jsonld` scrape context requests `https://acme.softy.pro/…`: no caller proxy (env proxy or direct); the same client to `example.com` uses proxy9 | `EVER_JOBS_CRAWL_BUILTIN_HOSTS=false` → proxy9 used for Softy |
| `crawl-sitemap.spec.ts` (CORE) | index with 3 children, child 1 answers 429: `fetchSitemap` rejects with that error, children 2-3 never requested; same for a `HostCoolingDownError` | `nestedErrors: 'skip'` → children 2-3 requested |
| `crawl-env.spec.ts` (CORE) | the 4 new `CRAWL_EXTRA_ENV` switches and 2 field vars parse, invalid values warn and fall back | — |
| `packages/models/__tests__/scrape-diagnostics-crawl.spec.ts` (CORE) | `preferRefusalError`: 502 then 429 → 429; 429 then 502 → 429; 502 then 500 → 502; 503 wins over 500 | mutation: return `current` → red |
| `apps/api/src/jobs/__tests__/jobs.service.multi-location.spec.ts` (API) | a location resolving `fetch_error` "…status code 503" stops the rest (`not attempted`); a thrown 503 too; `rate_limited`/`blocked` still stop | `EVER_JOBS_SEARCH_STOP_ON_503=false` → remaining locations attempted |
| `packages/plugin/src/circuit-breaker/__tests__/circuit-breaker.service.spec.ts` (API) | 5 resolved `{jobs:[], diagnostics:{reason:'rate_limited'}}` → open; `blocked` too; `fetch_error` / jobs > 0 do not count | `EVER_JOBS_BREAKER_COUNT_REFUSALS=false` → stays closed |
| `apps/api/src/jobs/__tests__/jobs.controller.crawl.spec.ts` (API) | `?liveness=true`: jobs with a fresh `jobUrlFetchedAt` are not probed and get `reason: 'fresh-fetch'`; a stale timestamp or a cache hit is probed | `EVER_JOBS_LIVENESS_TRUST_FRESH_FETCH=false` → all probed |
| `packages/plugins/liveness-http/__tests__/liveness-http.host-policy.spec.ts` (API, new) | probes of `a.softy.pro` and `b.softy.pro` share one bucket (`domain:softy.pro`), never 2 in flight, starts ≥ 1 s apart, one proxy (axios adapter fake, env proxies) | `EVER_JOBS_CRAWL_BUILTIN_HOSTS=false` → two `host:` buckets, overlap, two proxies |
| `apps/api/src/jobs/__tests__/jobs.service.crawl.spec.ts` (API) | Softy: caller `requestTimeout: 0.2` reaches the plugin as 60; caller `proxies` dropped (neither DTO nor context); non-locked site under `any`: both unchanged; global `none`: `requestTimeout` ignored for every site | `EVER_JOBS_CRAWL_STRICTER_RULES=1690` → 0.2 reaches Softy; operator `sites.softy.callerOverrides:'any'` → proxies kept |
| `sources-crawl-policy.controller.spec.ts`, `apps/api/__tests__/integration/crawl-policy.http.spec.ts` (API) | FR-3 meta for `softy` (plugin), `softy?host=acme.softy.pro`, `liveness-http?host=acme.softy.pro` (builtin-host), `linkedin` (default); `?crawl={"proxyRotation":"per-request"}` on softy → `meta.caller.rejected` | — |
| `gql-types.schema.spec.ts`, `apps/mcp/__tests__/crawl.spec.ts`, `tool-manifest.spec.ts` (API) | the two new fields on every surface; `callerOverrides` on none | — |

Integration verification (after all lanes): `npx tsc -p tsconfig.typecheck.json --noEmit`,
`npm run test:core`, `npm run test:sources` for the touched plugins (Softy, liveness-http,
plus any suite that reaches `*.softy.pro`), `npm run test:scripts`, `npm run lint:docs`.

## 9. Open Questions

Recorded in `docs/questions.md` (numbers from Q-120; Q-100..Q-119 belong to other
branches), each with a default the build proceeds with:

- **Q-120** — Compatibility switches added by this design beyond the brief
  (`EVER_JOBS_CRAWL_STRICTER_RULES`, `EVER_JOBS_CRAWL_PROXY_PIN_SCOPE`,
  `EVER_JOBS_CRAWL_ROBOTS_BACKOFF`, `EVER_JOBS_SEARCH_STOP_ON_503`, `SOFTY_LEGACY`
  tokens of Spec 1715): keep all (default — proceeding), or fold into fewer.
- **Q-121** — The builtin-host layer sits above env-global and the preset (as for the
  bulk-API builtins), so under `strict` the Softy entry lowers the throttle floor from
  30 s to 10 s, and a global `EVER_JOBS_CRAWL_MIN_INTERVAL_MS=2000` does not reach
  `*.softy.pro`. A: keep the precedence, operators use `hosts` entries (default —
  proceeding). B: make builtin hosts "never looser than the layers below".
- **Q-122** — Fleet-wide state (G15, G24, G27 remainder): cool-downs, pacing and caches
  stay per process; a Valkey-backed bucket is a follow-up spec. Default: the fleet-size
  knob only.
- **Q-123** — CI: the live Softy e2e runs on a weekly `schedule` of the CI workflow plus
  `workflow_dispatch` (Spec 1715). Default: weekly, Monday 04:23 UTC.
- **Q-124** — Deployment items outside this repo (G1 contact / `From` in prod, G29
  API-key auth and `EVER_JOBS_CRAWL_CALLER_PROXIES` in `k8s-gitops`). Default: not changed
  by this branch; the code locks cover Softy regardless.
- **Q-125** — `jobUrlFetchedAt` is a new public optional job field (the existing
  `liveness` field is request-scoped, opt-in and would leak into the cache and the stored
  corpus). Default: new field (proceeding).
- **Q-126** (docs pass) — The global `EVER_JOBS_CRAWL_CALLER_OVERRIDES` default stays
  `any`, so every source without a lock is still open to the caller overrides the audit
  showed for Softy. Default: keep `any`, lock per site on request (proceeding).
- **Q-127** (docs pass) — Our own deployments: set `EVER_JOBS_CRAWL_FLEET_SIZE` and a
  crawler contact (`EVER_JOBS_CRAWL_CONTACT` / `EVER_JOBS_CRAWL_FROM`)? Default: neither
  (no deployment change from this branch, Q-124).
- **Q-128** (docs pass) — Softy's retry and back-off numbers (1 retry on 429/503, 10 s
  throttle floor, 30 s server-error cool-down, 0.5 s idle gap). Default: keep.

## 10. Decisions

- D1 **Lock semantics.** Effective mode = most restrictive of global / plugin / builtin
  host; an operator per-site/host value replaces it (operator flexibility). A caller can
  never send `callerOverrides`.
- D2 **Which job field carries the fresh-fetch signal** (brief left to design): no
  existing field fits (`liveness` is opt-in, request-scoped and would be cached and
  persisted), so a new optional `jobUrlFetchedAt` (ISO time); the controller trusts it
  only when it is not older than the request start and the result is not a cache hit.
- D3 **How the effective caller mode is threaded into `resolve.ts`** (brief left to
  design): `explainCrawlPolicy` computes it while it walks the layers it already walks —
  `input.plugin` (the manifest from the scrape context; `JobsService` puts
  `meta.crawl` there) and `input.explicit` (the plugin's client options) for the plugin
  lock, the builtin patterns matching `input.host`, and the operator site/host entries —
  then filters the caller layer with it. `resolveCallerOverrides()` exposes the same
  computation without a policy, for `JobsService` (site level, no host) and `HttpClient`
  gets it through `getEffectiveCrawlResolution()` (memoised with the policy).
- D4 **Caller proxies under a lock** are refused in two places: `JobsService.scrapeOne`
  for the plugin's lock (so they reach neither the DTO nor the context), and `HttpClient`
  for a host lock reached by another plugin (scrape-context proxies and DTO-branch client
  proxies are skipped for that request).
- D5 **`requestTimeout`** is gated once per source in `JobsService.scrapeOne` with the
  site-level effective mode (REST, GraphQL, MCP-through-REST and CLI all reach it). A
  per-host clamp inside `HttpClient` was considered and rejected: a timeout on a locked
  host already cools the whole bucket (`serverErrorCooldownMs`), which bounds the overlap.
- D6 **Builtin Softy policy has no identity field**: `userAgentMode: 'identify'` at the
  builtin layer could loosen an operator's env `strict`; the manifest (plugin layer,
  which cannot relax `strict`) carries it instead.
- D7 **Fleet size** multiplies the start-to-start spacing (policy interval, robots
  `Crawl-delay` and the client's floor alike) and the idle gap, not jitter, cool-downs or
  concurrency.
- D8 **Old `stricter` comparators stay reachable** (`EVER_JOBS_CRAWL_STRICTER_RULES=1690`)
  per the no-removal rule; they are strictly looser than the new ones.

## 11. References

- Audit: 35 gaps (G0..G30, K0..K3), 2026-09-26; gap ids are cited per requirement.
- [Spec 1690](../1690-crawl-policy/spec.md), [Spec 1691](../1691-softy-sitemap-discovery/spec.md),
  [Spec 1715](../1715-softy-audit-hardening/spec.md).
- Code: `packages/common/src/http/crawl/{types,defaults,env,policy-schema,resolve,scrape-context,host-limiter,proxy-selector,sitemap}.ts`,
  `packages/common/src/http/http-client.ts`, `packages/models/src/dtos/{crawl-policy,job-post,scrape-diagnostics}.dto.ts`,
  `apps/api/src/jobs/{jobs.service,jobs.controller,health.controller,crawl-policy.mapping,gql-types}.ts`,
  `packages/plugin/src/circuit-breaker/circuit-breaker.service.ts`, `apps/mcp/src/tools.ts`.
