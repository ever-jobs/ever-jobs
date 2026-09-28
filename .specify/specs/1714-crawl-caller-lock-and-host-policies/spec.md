# Spec: 1714 — Crawl policy: site-owner caller lock, host-owned policies, gentler pacing knobs

| Field | Value |
|---|---|
| Spec ID | 1714 |
| Slug | crawl-caller-lock-and-host-policies |
| Status | in-progress |
| Owner | agent |
| Created | 2026-09-26 |
| Last updated | 2026-09-27 |
| Supersedes | — |
| Related specs | 1690 (crawl policy), 1691 (Softy sitemap discovery), 1715 (Softy audit hardening, the plugin half of this work), 005 (circuit breaker), 721 / 740 (liveness), 1700 (multi-location search) |
| Plan / tasks | [plan.md](./plan.md) · [tasks.md](./tasks.md) |
| Operator guide | [docs/CRAWL_POLICY.md](../../../docs/CRAWL_POLICY.md) |
| Audit gaps closed | G0, G2, G3, G4, G5, G7, G8, G9, G10, G11, G12, G14, G15 (part), G16, G17, G18, G22 (part), G27, G28, G29 (part), K2, K3 |
| Review round 2 (2026-09-27) | shared-layer and API findings A0, A3 (API half), C0, C1 (liveness half), C3, F3, F5 (meta), F7, F8 and a flaky timing test: FR-19..FR-27, tasks T21..T32. Refuted and not fixed: F0, F1 (its doc / meta core folded into F5), F2 / C2, F6, A2, A4 |

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
| FR-6 | The `per-host` proxy pick keys on the registrable domain whenever the base scope (the scope resolved without the caller) is `domain`, so two tenants of one site never exit through different proxies because of a caller setting. `EVER_JOBS_CRAWL_PROXY_PIN_SCOPE=bucket` restores the pre-1714 pick (the request's bucket). Round 2 (FR-24): only under a lock or a builtin lock host; every unlocked source keeps the pre-1714 pick. | G10, G11 | must |
| FR-7 | `requestTimeout` (flat DTO field, seconds): under effective mode `stricter` only a value ≥ the resolved default (60 s) is accepted, otherwise the default is used; under `none` it is ignored (default used); under `any` it passes unchanged. Helper `gateCallerRequestTimeout` exported from `@ever-jobs/common`; `apps/api` applies it once per source in `JobsService.scrapeOne`, which the REST, GraphQL, MCP (via REST) and CLI paths all reach. Round 2 (FR-23): `HttpClient` also gates a caller's timeout per request host. | K3 | must |
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

**Review round 2 (2026-09-27).** A review of the landed work confirmed the findings below
(ids from the review; A = the asks lens, C = correctness, F = flexibility). Each keeps the
old behaviour behind the switch named.

| ID | Requirement | Finding | Priority |
|---|---|---|---|
| FR-19 | **Redirect pacing.** `HttpClient` does not follow a redirect hop inside the request's limiter slot when the hop's host falls in a different rate-limit bucket (its own resolved scope) or `isPolicyOwnedHost(host)` is true (a builtin — not disabled — or operator `hosts` entry matching it with `callerOverrides` `stricter` / `none` or `rateLimitScope: 'domain'`). The per-attempt `beforeRedirect` first runs the existing guards (pin, egress check, the request's own hook), then throws a private `DeferredRedirect`; `HttpClient` records the `3xx` as the slot's outcome, releases the slot and re-issues the hop through the full pipeline (robots.txt, lock, proxy pick, slot, cool-down, retries; not the multi-location memo — FR-29). It keeps what follow-redirects would change (`GET` without a body after a `301`/`302` `POST` or a `303`; dropped headers sent as `false`; `auth` dropped off-origin; the per-request `crawl` carried). The whole chain is capped at `config.maxRedirects ?? DEFAULT_MAX_REDIRECTS` (21), then `ERR_FR_TOO_MANY_REDIRECTS`. Same-bucket hops to ordinary hosts, `307`/`308` hops with a non-replayable body and `maxRedirects: 0` keep the in-slot behaviour. `EVER_JOBS_CRAWL_PACE_REDIRECTS` (default `true`; `false` = pre-fix; `false` under `legacy`). **Amended in the second review pass (FR-28):** a hop to a different bucket is re-issued only under a caller lock; an unlocked chain that stays off host-owned policies is followed in the slot. | A0 (G6 remainder) | must |
| FR-20 | `EVER_JOBS_CRAWL_BUILTIN_HOSTS_DISABLE`: comma / whitespace list of `BUILTIN_HOST_POLICIES` keys (normalised, de-duplicated; unknown → warning, ignored), default empty. Skipped in `explainCrawlPolicy` (with a note per skipped pattern, `builtinHostPatternsDisabled`), `resolveCallerOverrides` and `isPolicyOwnedHost`. `crawlBuiltinHostsDisabled(env)` exposes the list. The restore rows for "other plugins reach `*.softy.pro` under the generic defaults" use `*.softy.pro,softy.pro` instead of `EVER_JOBS_CRAWL_BUILTIN_HOSTS=false`, which also drops the pre-1714 bulk-API limits. | F3 | must |
| FR-21 | **`legacy` restores the new switches.** Unset, `EVER_JOBS_CRAWL_STRICTER_RULES` = `1690`, `EVER_JOBS_CRAWL_PROXY_PIN_SCOPE` = `bucket`, `EVER_JOBS_CRAWL_ROBOTS_BACKOFF` = `false`, `EVER_JOBS_CRAWL_PACE_REDIRECTS` = `false` under `EVER_JOBS_CRAWL_PRESET=legacy` (env parse and the accessors for hand-built configs), and the API switches `EVER_JOBS_BREAKER_COUNT_REFUSALS`, `EVER_JOBS_SEARCH_STOP_ON_503`, `EVER_JOBS_LIVENESS_TRUST_FRESH_FETCH` = `false`, `EVER_JOBS_LIVENESS_TRUST_LISTED_MAX_AGE_MS` = `0` (preset read through `readCrawlPolicyEnv`: `crawlPresetIsLegacy()`). An explicit value wins. `CRAWL_POLICY.md` §16 says exactly what `legacy` restores and what it does not (`ABORT_ON_DEADLINE`, `CIRCUIT_MAX_SITES`, plugin settings such as `SOFTY_*` and the Softy client floor). | F7 | must |
| FR-22 | Invalid values of the API switches warn **once per variable and value** (`warnInvalidSwitchOnce`, a module-level set; `resetSwitchWarnings()` for tests), naming the variable and the value used; the breaker's `readBreakerCountRefusals` passes `(raw, used)` to `onInvalid`. | F8 | must |
| FR-23 | **Caller timeouts per request host.** `HttpClient` treats a timeout as the search caller's when the client took it from a real `ScraperInputDto` (`timeoutFromCaller`, set by `clientOptionsFromScraperInput`) or it equals the scrape context's new `callerRequestTimeout` (seconds; a per-request `timeout` in ms is compared × 1000). Such a timeout is gated with `gateCallerRequestTimeout` and the effective caller mode of the REQUEST host (robots.txt fetch included), and a client-side timeout (`ECONNABORTED` / `ETIMEDOUT`, no answer) of a caller's timeout below `DEFAULT_REQUEST_TIMEOUT_SECONDS` never applies `serverErrorCooldownMs`. Unlocked hosts are unchanged. `EVER_JOBS_CRAWL_STRICTER_RULES=1690` turns both off. **Done:** `JobsService.scrapeOne` sets `ScrapeContext.callerRequestTimeout` to the gated `requestTimeout` of every source (T26, commit d235e9df), so a plugin that copies `requestTimeout` into its own `timeout` option (JSON-LD) is covered on the search API too. | C0 | must |
| FR-24 | The `per-host` proxy pin keys on the base scope only when the effective caller mode is not `any` or an applied builtin host pattern carries a site owner's lock; otherwise the pre-1714 bucket key — byte-identical for every unlocked source, including under a `domain` base scope from the preset or env. `EffectiveCrawlResolution.builtinHostPatterns` carries the applied patterns. | C3 | must |
| FR-25 | **Listing evidence for liveness** (API half). `JobPostDto.jobUrlListedAt?: string \| null` (ISO-8601 UTC: when the source's index that listed the posting was fetched from the network), `JOB_LIVENESS_REASON_LISTED = 'listed'`, type `JobLivenessReason`. `markFreshlyFetched` (JSON, CSV and NDJSON) marks a job `{ state: 'active', checkedAt: jobUrlListedAt, reason: 'listed' }` when `0 <= now - listedAt <= EVER_JOBS_LIVENESS_TRUST_LISTED_MAX_AGE_MS` (default 600000; `0` = off = pre-fix), measured against now (cache hits included); a fresh fetch wins; a future or unparseable time is probed; trusted jobs do not count toward `EVER_JOBS_LIVENESS_MAX_URLS`. Mirrored as `searchSwitches.livenessTrustListedMaxAgeMs`; `tool_manifest.json` output field. | A3 | must |
| FR-26 | Policy API meta: `meta.builtinHostsDisabled` (FR-20) and `meta.clientMinIntervalFloorMs` — a plugin's declared `IPluginMetadata.clientMinIntervalFloorMs` (finite, positive), else `null`. **Done:** the Softy plugin declares it (Spec 1715 T22, commit d235e9df); since the second review pass (FR-31) the API reports the EFFECTIVE floor. | F3, F5 (F1 core) | should |
| FR-27 | Timing tests measure what the limiter promises: `jobs.service.plugin-crawl.spec.ts` asserts the floors on the limiter's grant instants (a recording `HostLimiter`), not on the mocked adapter's clock, with no slack; the liveness host-policy test adds a fast-answer case that only `minIntervalMs` can hold ≥ 1 s apart, with a control that lowers only the interval. | flaky CI test, C1 | must |
| FR-28 | **Redirect pacing keeps unlocked sources byte-identical** (second review pass). `pacedRedirectHook` re-issues a hop only when the hop host is host-owned (`isPolicyOwnedHost`, or an applied builtin pattern with a site owner's lock — `builtinHostLockApplies`), or when the hop leaves the request's bucket AND the request or the hop is under a caller lock (effective mode not `any`). Every other hop — a cross-host hop of a source without a lock included — is followed inside the slot, with the slot's proxy, exactly as before Spec 1714 (rule 3: the round-1 code gave such a hop a second slot and a second proxy pick, a new egress IP mid-chain). A0 is still covered: an aggregator link into `*.softy.pro` reaches a host-owned policy. `EVER_JOBS_CRAWL_PACE_REDIRECTS=false` still restores the in-slot follow everywhere. | correctness (second pass) | must |
| FR-29 | **A re-issued hop never consults the multi-location memo** (second review pass). `send()` calls `sendUnderPolicy` directly when `redirectHops > 0`: the request that started the chain holds the memo entry for the whole chain, and a chain coming back to a URL it visited (A → B → A, or a same-URL bounce on a host-owned policy) found that entry pending and waited on itself — no answer until the search deadline (or never, with the deadline or the deadline abort off). Now it fails with `ERR_FR_TOO_MANY_REDIRECTS` past `maxRedirects`. A bug fix of FR-19 (no switch: the pre-1714 path is `EVER_JOBS_CRAWL_PACE_REDIRECTS=false`). | correctness (second pass) | must |
| FR-30 | **A locked host keeps one origin: `proxyRotation`** (second review pass). Under `stricter` and rules `1714`, a caller's `proxyRotation` is accepted only when it equals the base value, or is `off` while no proxy list resolves (`EVER_JOBS_CRAWL_PROXIES` / `DEFAULT_PROXIES` empty, when `off` changes nothing on the wire). The round-1 order ranked `off` above `per-host`, so under the Softy lock a caller's `off` sent its Softy requests from the server IP while every other Softy request used the pinned proxy (two origins, ask C). `filterCallerOverride` takes `{ rules, proxyRotation, proxiesConfigured }` (`StricterOptions`); `explainCrawlPolicy` passes the env values. `EVER_JOBS_CRAWL_CALLER_PROXY_ROTATION`: `base` (default) \| `ranked` (the round-1 order; the default under `legacy`). Rules `1690` keep their own order. | asks (second pass) | must |
| FR-31 | **The policy API reports what is in force** (second review pass). `meta.clientMinIntervalFloorMs` is the EFFECTIVE floor: `IPluginMetadata.clientMinIntervalFloor?: () => number` (read per call; Softy: `() => readSoftyConfig().minIntervalFloorMs`, `0` → `null` under `SOFTY_LEGACY=no-interval-floor`), else the declared `clientMinIntervalFloorMs`; plus `meta.clientMinIntervalFloorSwitch` (`IPluginMetadata.clientMinIntervalFloorSwitch`). `meta.switches` = `{ stricterRules, proxyPinScope, robotsBackoff, paceRedirects, callerProxyRotation }` as in force, and `meta.proxyPin` = `{ scope, keyedOn }` — `effectiveProxyPinScope` (the rule `HttpClient` applies, now shared) and the key's scope. The boot-time config mirror adds `proxyPinScope`, `robotsBackoff`, `callerProxyRotation`. | flexibility (second pass) | should |
| FR-32 | **A failed attempt records its cool-down before it frees its slot** (review of PR #105). `sendUnderPolicy` freed the limiter slot in a `finally` and only then recorded the failure (`recordOutcome`, the server-error cool-down, the 429/503 back-off, a give-up `Retry-After`); freeing a slot pumps the queue, which grants an eligible waiter synchronously, so a request queued behind a 502 / 503 / 429 was granted — and sent — inside the cool-down the next lines set. The failure handling is now `settleFailedAttempt`, and under `EVER_JOBS_CRAWL_COOLDOWN_BEFORE_RELEASE` the slot is freed after it: `locked` (default) — a request under a lock (`crawlLockApplies`: effective caller mode not `any`, or an applied builtin pattern with a site owner's lock, so every request to `*.softy.pro`); `all` — every request; `off` — the pre-fix order everywhere (the default under `legacy`). A source without a lock keeps the pre-fix order under the default (rule 3). A deferred redirect's slot is freed before the hop is re-issued, in every mode. Shown in `meta.switches.cooldownBeforeRelease` and the config mirror. Under Softy's builtin 500 ms `minGapMs` the next grant already waited past the penalty (the pump re-checks), so the window is open only on a bucket without an idle gap whose interval has passed. | G1 (PR #105 review) | must |
| FR-33 | **A fresh fetch is trusted only up to now** (review of PR #105). `markFreshlyFetched` trusts `jobUrlFetchedAt` when `trustSince <= fetchedAt <= now` — the same upper bound as `jobUrlListedAt` (FR-25): a fetch time in the future (a plugin clock ahead of ours, a bad value) is probed, and a young `jobUrlListedAt` on the same job still counts. A fix of FR-16 on this branch (no switch: `EVER_JOBS_LIVENESS_TRUST_FRESH_FETCH=false` is the pre-1714 path). | G3 (PR #105 review) | must |
| FR-34 | **Known limitation — browser redirects are not paced by the destination policy** (review of PR #105). `EVER_JOBS_CRAWL_PACE_REDIRECTS` covers `HttpClient` only. `BrowserPool.navigate` resolves the first URL's policy once and `page.goto` follows every redirect inside that slot (a vanity careers URL answering `302` to `*.softy.pro` reaches Softy under the first host's bucket, lock and pacing), and the navigation's `429` / `503` / `5xx` is recorded on the first host's bucket. Not fixed: Playwright calls a `page.route` handler only for the first URL of a redirect chain (its API contract), so a hop cannot be paused; stopping at a `3xx` needs the navigation fetched outside the browser (`route.fetch` with `maxRedirects: 0` — another TLS / HTTP stack, cookie and cache handling for every navigated page, which would change every browser source, unlocked ones included, against rule 3) or a Chromium-only CDP `Fetch` session at the response stage. Both are a redesign of the browser path, recorded as a follow-up; `CRAWL_POLICY.md` §9 and §20 say so. No Softy code path uses the browser. | G2 (PR #105 review) | should |

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

Review round 2 (2026-09-27) added, as landed:

```ts
// env.ts — CRAWL_EXTRA_ENV gains:
//   BUILTIN_HOSTS_DISABLE: 'EVER_JOBS_CRAWL_BUILTIN_HOSTS_DISABLE'  (comma list of BUILTIN_HOST_POLICIES keys; default [])
//   PACE_REDIRECTS: 'EVER_JOBS_CRAWL_PACE_REDIRECTS'                (bool; default true, false under legacy)
// STRICTER_RULES / PROXY_PIN_SCOPE / ROBOTS_BACKOFF now default to 1690 / bucket / false under legacy.
// ParsedCrawlPolicyEnv gains paceRedirects?, builtinHostsDisable?
export function crawlPaceRedirectsEnabled(env: CrawlPolicyEnvConfig): boolean;   // missing → !legacy
export function crawlBuiltinHostsDisabled(env: CrawlPolicyEnvConfig): string[];  // missing → []

// resolve.ts
export interface CrawlPolicyExplanation {
  /** Builtin patterns matching the host but skipped by EVER_JOBS_CRAWL_BUILTIN_HOSTS_DISABLE. */
  builtinHostPatternsDisabled: string[];
}
/** A builtin (not disabled) or operator `hosts` entry matching `host` with a caller lock or a
 *  `domain` scope: a redirect hop there is re-issued even in the same bucket (FR-19). */
export function isPolicyOwnedHost(host: string | undefined, env?: CrawlPolicyEnvConfig): boolean;

// caller-lock.ts
/** mode `stricter` / `none` decided by `plugin` or `builtin-host` (not by the operator). */
export function isSiteOwnerCallerLock(lock: Pick<CallerOverridesResolution, 'mode' | 'source'> | undefined | null): boolean;

// scrape-context.ts
export interface EffectiveCrawlResolution { builtinHostPatterns: string[] }        // FR-24
export function getEffectiveCallerOverrides(host?: string, explicit?: CrawlPolicyOverride): CallerOverridesResolution;
export function resolveCrawlInContext(ctx: ScrapeContext | undefined, host?: string, explicit?: CrawlPolicyOverride): EffectiveCrawlResolution;

// types.ts — ScrapeContext gains
callerRequestTimeout?: number;   // seconds: the caller's requestTimeout after JobsService's gate (FR-23)

// http-client.ts
export const DEFAULT_MAX_REDIRECTS = 21;   // follow-redirects' default, which axios uses when maxRedirects is unset
// HttpClientOptions gains timeoutFromCaller?: boolean (set by clientOptionsFromScraperInput for a real DTO)

// packages/plugin — IPluginMetadata gains clientMinIntervalFloorMs?: number (informational, FR-26)
// apps/api — crawl-policy.mapping.ts: LIVENESS_TRUST_LISTED_MAX_AGE_ENV, DEFAULT_LIVENESS_TRUST_LISTED_MAX_AGE_MS (600000),
//   livenessTrustListedMaxAgeMs(), crawlPresetIsLegacy(), warnInvalidSwitchOnce(), resetSwitchWarnings();
//   health.controller.ts: clientMinIntervalFloorMs(value) → number | null
```

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
// Review round 2 (FR-25):
/** ISO-8601 UTC instant at which the index (sitemap) that listed this posting was fetched
 *  from the network — by this request or an earlier one the source still caches. */
jobUrlListedAt?: string | null;
export const JOB_LIVENESS_REASON_LISTED = 'listed';
export type JobLivenessReason = typeof JOB_LIVENESS_REASON_FRESH_FETCH | typeof JOB_LIVENESS_REASON_LISTED;
// `liveness.reason` stays typed `string`, so clients keep reading reasons added later.

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
| `proxyRotation` | **equal only — or `off` while no proxy list resolves** (FR-30; a caller never moves a locked host to another origin). `EVER_JOBS_CRAWL_CALLER_PROXY_ROTATION=ranked`: off < per-host < per-scrape < per-request, accept ≤ base (round 1) | off = per-host > per-scrape > per-request |
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
| `EVER_JOBS_CRAWL_STRICTER_RULES` | `1714` \| `1690` (`1714`; `1690` under `legacy`, round 2) | `1690` |
| `EVER_JOBS_CRAWL_PROXY_PIN_SCOPE` | `base` \| `bucket` (`base`; `bucket` under `legacy`, round 2) | `bucket` |
| `EVER_JOBS_CRAWL_ROBOTS_BACKOFF` | bool (`true`; `false` under `legacy`, round 2) | `false` |
| `EVER_JOBS_CRAWL_PACE_REDIRECTS` (round 2) | bool (`true`; `false` under `legacy`) | `false` |
| `EVER_JOBS_CRAWL_CALLER_PROXY_ROTATION` (round 2, second pass) | `base` \| `ranked` (`base`; `ranked` under `legacy`) | `ranked` (the round-1 order; with `EVER_JOBS_CRAWL_STRICTER_RULES=1690` the Spec 1690 order) |
| `EVER_JOBS_CRAWL_COOLDOWN_BEFORE_RELEASE` (PR #105 review) | `locked` \| `all` \| `off` (`locked`; `off` under `legacy`) | `off` (a failed attempt frees its slot before its cool-down is recorded, for every request) |
| `EVER_JOBS_CRAWL_BUILTIN_HOSTS_DISABLE` (round 2) | comma list of builtin host patterns (empty) | `*.softy.pro,softy.pro` (only Softy's builtin entries; the pre-1714 bulk-API limits stay) |
| `EVER_JOBS_SEARCH_STOP_ON_503` | bool (`true`; `false` under `legacy`, round 2) | `false` |
| `EVER_JOBS_BREAKER_COUNT_REFUSALS` | bool (`true`; `false` under `legacy`, round 2) | `false` |
| `EVER_JOBS_LIVENESS_TRUST_FRESH_FETCH` | bool (`true`; `false` under `legacy`, round 2) | `false` |
| `EVER_JOBS_LIVENESS_TRUST_LISTED_MAX_AGE_MS` (round 2) | int ms (`600000`; `0` under `legacy`; `0` = off) | `0` (probing every URL needs this and `EVER_JOBS_LIVENESS_TRUST_FRESH_FETCH=false`) |
| `EVER_JOBS_CRAWL_CALLER_OVERRIDES` | unchanged: `any` \| `stricter` \| `none` (`any`) | — |

An invalid value of an API switch keeps its default and is logged once per variable and
value (round 2, FR-22); the crawl switches warn as every crawl env value does.

The Softy lock itself is undone per install by an operator policy:
`{"sites":{"softy":{"callerOverrides":"any"}},"hosts":{"*.softy.pro":{"callerOverrides":"any"},"softy.pro":{"callerOverrides":"any"}}}`
**plus `SOFTY_LEGACY=no-interval-floor`** (round 2, F5: the Softy client's 1 s floor is a
client option no policy layer lifts, so without it a caller's `minIntervalMs: 0` still
leaves Softy's own requests 1 s apart) — or, more bluntly, `EVER_JOBS_CRAWL_PLUGIN_MANIFESTS=false`
and `EVER_JOBS_CRAWL_BUILTIN_HOSTS=false` (every manifest / builtin host off), again with
`SOFTY_LEGACY=no-interval-floor`. The whole pre-1715 Softy crawl policy (manifest retries,
back-off, idle gap, cool-down, UA mode) is an operator recipe in `docs/CRAWL_POLICY.md` §16:
`EVER_JOBS_CRAWL_BUILTIN_HOSTS_DISABLE=*.softy.pro,softy.pro`, `SOFTY_LEGACY=no-interval-floor`
and a `sites.softy` entry with the preset's values. A builtin host entry sits above
env-global values, so a slower global `EVER_JOBS_CRAWL_MIN_INTERVAL_MS` does not reach
`*.softy.pro` either (Q-121); an operator `hosts` entry does.

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
- Round 2: `meta.builtinHostsDisabled` (FR-20) and `meta.clientMinIntervalFloorMs`
  (FR-26) on the policy endpoint; optional job field `jobUrlListedAt` (REST JSON,
  `tool_manifest.json`) and `liveness.reason: 'listed'` (FR-25); configuration mirrors
  `crawl.paceRedirects`, `crawl.builtinHostsDisabled`,
  `searchSwitches.livenessTrustListedMaxAgeMs`.

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

Review round 2 (2026-09-27):

| Test (lane) | Asserts | Red control |
|---|---|---|
| `packages/common/__tests__/http-client-redirect-pacing.spec.ts` (CORE, new; real axios + follow-redirects, loopback servers, names mapped to 127.0.0.1 by an agent `lookup`) | FR-19: a direct probe of `acme.softy.pro` and an aggregator link that `302`s to another Softy offer (site `liveness-http`): the hop takes a `domain:softy.pro` slot of its own, granted ≥ 1000 ms after the first (limiter grant clock) and arriving ≥ 1000 ms later; a same-host `/offres` → `/offers` hop on a Softy tenant is re-issued 1 s later; the re-issued hop is checked against its origin's robots.txt (`RobotsDisallowedError`); ordinary same-bucket hops stay in the slot; `POST` + `301`/`302`/`303` → `GET` without body or `Content-*`, `307`/`308` keep method and body; off-domain `Authorization` / `Cookie` not merged back; the per-request `crawl` goes along; `maxRedirects: 3` across two buckets → 4 requests then `ERR_FR_TOO_MANY_REDIRECTS` (paced or not); `maxRedirects: 0` untouched | `EVER_JOBS_CRAWL_PACE_REDIRECTS=false` → one Softy slot, the hop arrives < 1000 ms after it, the disallowed page is fetched; `legacy` preset → one slot; `EVER_JOBS_CRAWL_BUILTIN_HOSTS_DISABLE=*.softy.pro` → the same-host hop follows in a `host:` slot |
| `http-client-redirects.spec.ts` (CORE) | with pacing on, the pin, then the egress check, then the request's own hook still run before the decision; `EgressBlockedError` (not a deferral) with the pin off; a same-bucket hop is followed | — |
| `crawl-caller-lock.spec.ts` (CORE) | FR-20: `*.softy.pro,softy.pro` disabled → generic limits and no lock for other plugins (noted), bulk-API builtin limits kept, disabling only the apex leaves tenants locked, the Softy manifest kept, the whole-layer switch wins; `isPolicyOwnedHost` for builtin / operator entries with a lock or `domain` scope (pacing alone does not count), following both builtin switches; `isSiteOwnerCallerLock` agrees with `resolveCallerOverrides` | the Greenhouse case under `EVER_JOBS_CRAWL_BUILTIN_HOSTS=false` (4 / 100 ms instead of 16 / 0) |
| `crawl-env.spec.ts` (CORE) | FR-21: under `legacy` STRICTER_RULES `1690`, PROXY_PIN_SCOPE `bucket`, ROBOTS_BACKOFF / PACE_REDIRECTS `false`; `polite` / `strict` keep the new values; an explicit value wins either way; an invalid value under `legacy` warns and keeps the legacy default; the accessors follow the preset on hand-built configs. `PACE_REDIRECTS` parses like every boolean switch; `BUILTIN_HOSTS_DISABLE` normalises, de-duplicates and warns on a non-builtin pattern | — |
| `crawl-scrape-context.spec.ts` (CORE) | `builtinHostPatterns` on the resolution (copied per call); `getEffectiveCallerOverrides` inside the Softy scrape (plugin lock), on a Softy host from another plugin (builtin-host), under an operator `sites.softy` value (not a site owner's lock); `resolveCrawlInContext` for an explicit context | — |
| `http-client-crawl-policy.spec.ts` (CORE) | FR-23 (a): an unlocked plugin with the caller's 0.001 s to `acme.softy.pro` → 60 s, to `example.com` → 1 ms; no 30 s cool-down of `domain:softy.pro` from the caller's abort; a plugin's own timeout never touched; a per-request timeout equal to the caller value gated, another not; the DTO branch counts without a context value; a value ≥ 60 s passes, an operator `none` on the host forces the default; the robots.txt request gets the gated timeout. (b): a caller's 1 s timeout on an unlocked host with an operator cool-down does not cool it; a plugin's own short timeout and a caller's timeout at the default still do; a reset under a caller's short timeout still counts. FR-24: two Softy tenants share one proxy even with callers unlocked by the operator and a caller `host` scope; a site lock under rules `1690` still pins the base domain; an unlocked source keeps the pre-1714 pick for every golden case; Greenhouse (builtin host, no lock) keeps the bucket pick | `EVER_JOBS_CRAWL_STRICTER_RULES=1690` → 1 ms abort and `domain:softy.pro` cools 30 s; the caller's short timeout counts as struggling |
| `apps/api/src/jobs/__tests__/crawl-policy.switches.spec.ts` (API, new) | FR-21 / FR-22: `crawlPresetIsLegacy` agrees with the crawl layer (spellings, invalid preset = `polite`); each switch defaults to its new value, to the pre-1714 one under `legacy`, an explicit value wins; an invalid value keeps the default and is logged once per value naming the variable and the value used; `EVER_JOBS_LIVENESS_TRUST_LISTED_MAX_AGE_MS` 600000 / `0` under `legacy`, rejects `ten`, `-1`, `1.5`, `1e3`, `600000ms` and an unsafe integer | — |
| `circuit-breaker.refusals.spec.ts` (API) | `readBreakerCountRefusals` → `false` under `legacy` (any accepted spelling), `true` for `polite` / `strict` / an invalid preset; an explicit value wins; `onInvalid(raw, used)`; a breaker built under `legacy` keeps refused results as successes | `EVER_JOBS_BREAKER_COUNT_REFUSALS=true` under `legacy` → opens |
| `jobs.controller.liveness-listed.spec.ts` (API, new) | FR-25 on JSON and NDJSON: a fresh listing trusted (`reason: 'listed'`, `checkedAt` = listing time), a stale one probed, the operator bound applies, a search-cache hit trusted while young, a future or unparseable time probed, a fresh fetch wins, trusted jobs outside the probe cap, `EVER_JOBS_LIVENESS_ENABLED=false` withholds all | `EVER_JOBS_LIVENESS_TRUST_LISTED_MAX_AGE_MS=0` → every job probed (and both switches off → all probed, pre-1714) |
| `jobs.controller.liveness-trust-paths.spec.ts` (API, new) | the fresh-fetch trust on the JSON / NDJSON paths and the probe cap (Specs 1721 / 1723 × FR-16) | `EVER_JOBS_LIVENESS_TRUST_FRESH_FETCH=false` |
| `sources-crawl-policy.controller.spec.ts` (API) | FR-26: `meta.builtinHostsDisabled` `[]` by default, the disabled list whatever the host, only those patterns stop applying (Greenhouse keeps its builtin host); `meta.clientMinIntervalFloorMs` = the declared floor, `null` when none / 0 / junk | — |
| `packages/models/__tests__/job-post-board-fields.spec.ts`, `tool-manifest.spec.ts` | `jobUrlListedAt` optional, distinct from `jobUrlFetchedAt`, JSON round trip; `JOB_LIVENESS_REASON_LISTED === 'listed'`; the manifest advertises the output field | — |
| `liveness-http.host-policy.spec.ts` (API) | FR-27 / C1: probes of Softy tenants answered in 20 ms still start ≥ 1 s apart although the idle gap alone would allow 520 ms | an operator `hosts["*.softy.pro"] {minIntervalMs: 0}` (`minGapMs` kept) → starts exactly answer + 500 ms apart |
| `jobs.service.plugin-crawl.spec.ts` (API) | FR-27: the RemoteOK 1000 ms, WTTJ 500 ms and Simplify 2000 ms floors hold between the limiter's GRANT instants (a recording `HostLimiter`), one grant per wire request, no slack | the diagnosis: the old adapter-clock gaps read up to 13 ms under the grant gaps (987 / 988 / 994 ms on loaded Linux CI; up to 52 ms under a CPU burner on Windows) while the grants were never < 1000 ms apart |

Second review pass and the PR #105 review (2026-09-27):

| Test (lane) | Asserts | Red control |
|---|---|---|
| `http-client-redirect-pacing.spec.ts` (CORE) | FR-28: 4 loopback CONNECT proxies as `EVER_JOBS_CRAWL_PROXIES`, the default preset, an A → B `302` across hosts: an unlocked source keeps one grant and one proxy for both requests, like `EVER_JOBS_CRAWL_PACE_REDIRECTS=false`; under `EVER_JOBS_CRAWL_CALLER_OVERRIDES=stricter` the hop is re-issued (its own grant and pick); without a lock the robots.txt twin follows the disallowed hop in the slot. FR-29: an A → B → A loop inside `runWithHttpMemo` rejects with `ERR_FR_TOO_MANY_REDIRECTS` after 6 requests (0 memo hits), a same-URL bounce on an operator host with a lock after 3, the same loop outside a memo scope likewise | FR-28: the round-1 hook (every cross-bucket hop re-issued) — the golden, the robots twin, the `http-client-redirects` and egress-guard twins fail (4 tests). FR-29: the round-1 `send()` (memo consulted for hops) — both memo loops settle as `hung` (8 s guard) |
| `crawl-caller-lock.spec.ts`, `crawl-resolve.spec.ts` (CORE) | FR-30: for the Softy plugin, JSON-LD on a Softy page and a liveness probe, a caller's `off` is refused while env proxies are set, `per-scrape` / `per-request` refused, the base accepted; `off` accepted without any proxy list; an unlocked source takes any value; the comparator table for every base × candidate with and without a proxy list | the round-1 comparator (`off` ranked strictest) — 9 tests fail; `EVER_JOBS_CRAWL_CALLER_PROXY_ROTATION=ranked` accepts `off` |
| `sources-crawl-policy.controller.spec.ts`, `apps/api/src/config/__tests__/crawl-mirror.spec.ts` (API) | FR-31: the real Softy metadata reports 1000 and its switch; `null` under `SOFTY_LEGACY=no-interval-floor` (with the unlock recipe and a caller `minIntervalMs: 0`) and under `all`; a throwing resolver falls back to the declared value; `meta.switches` and the config mirror at their defaults, under `legacy`, with explicit values; `meta.proxyPin` for a locked Softy host, an unlocked source, `PROXY_PIN_SCOPE=bucket`, and an operator-lifted Softy lock | the declared-only floor (2 tests), the controller / mirror without the switches (9 tests) |
| `http-client-cooldown-before-release.spec.ts` (CORE, new; fake adapter, fake timers, one slot, no interval) | FR-32: under a lock a request queued behind a `502` (`serverErrorCooldownMs` 300), a `503` (5 s floor), a `429` `Retry-After: 2` starts exactly when the cool-down ends; behind a give-up `429` (`Retry-After` 1 h) it is never sent (`HostCoolingDownError`); the builtin Softy lock holds it for the 30 s cool-down with no operator lock (operator `minGapMs: 0`); an unlocked source keeps the pre-fix order under the default, `all` extends the fix; the switch parses, follows `legacy`, warns on junk | the pre-fix order (`holdSlotOnFailure` forced false) — 6 tests fail; `EVER_JOBS_CRAWL_COOLDOWN_BEFORE_RELEASE=off` → the queued request starts the instant the failure came back (inside the cool-down; into the 1 h give-up too) |
| `jobs.controller.liveness-listed.spec.ts` (API) | FR-33 on JSON and NDJSON: a `jobUrlFetchedAt` in the future is probed while one up to now is trusted as `fresh-fetch`; a future fetch time does not hide a young `jobUrlListedAt` | without the `<= now` bound — 4 tests fail (the future fetch is trusted) |

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
  **Amended in review round 2 (C0, FR-23):** that cool-down was itself the problem — a
  caller's tiny timeout on an unlocked plugin reaching `*.softy.pro` put all of
  `softy.pro` into the 30 s cool-down, although the server never slowed down. So
  `HttpClient` now also gates a caller's timeout per request host, and a caller's short
  timeout never counts as a struggling server.
- D6 **Builtin Softy policy has no identity field**: `userAgentMode: 'identify'` at the
  builtin layer could loosen an operator's env `strict`; the manifest (plugin layer,
  which cannot relax `strict`) carries it instead.
- D7 **Fleet size** multiplies the start-to-start spacing (policy interval, robots
  `Crawl-delay` and the client's floor alike) and the idle gap, not jitter, cool-downs or
  concurrency.
- D8 **Old `stricter` comparators stay reachable** (`EVER_JOBS_CRAWL_STRICTER_RULES=1690`)
  per the no-removal rule; they are strictly looser than the new ones.
- D9 **Redirect hop budget** (round 2, FR-19): the review brief said to cap re-issued
  chains at "the axios default (5)", but the installed axios passes no `maxRedirects` to
  follow-redirects, whose own default is 21. The cap is `config.maxRedirects ?? 21`
  (`DEFAULT_MAX_REDIRECTS`), so the redirect budget a request had before is unchanged.
- D10 **What counts as a caller's timeout** (round 2, FR-23): only a timeout the client
  took from a real search DTO, or one equal to the scrape context's
  `callerRequestTimeout`. A plugin's own timeout option is never gated, so a plugin that
  happens to use the caller's value by coincidence is gated too — an accepted edge.
  Recognising a copied value needs `JobsService` to fill `callerRequestTimeout` (T26,
  done in d235e9df).
- D11 **The `legacy` preset follows the new switches** (round 2, FR-21), like
  `BUILTIN_HOSTS` / `PLUGIN_MANIFESTS` before them, rather than documenting a list of
  extra switches for "all of it"; plugin settings (`SOFTY_*`, client floors) stay the
  plugin's (listed in `CRAWL_POLICY.md` §16).
- D12 **Redirect pacing keys on the hop's bucket and on host ownership**, not on every
  cross-host hop: a hop in the same bucket to an ordinary host keeps the in-slot follow,
  so unlocked sources see no extra limiter slot for a same-host redirect. A same-bucket
  hop on a host-owned policy is re-issued anyway, because that host asked to be paced
  per request (`/offres` → `/offers` on a Softy tenant). **Second review pass (FR-28):**
  a cross-bucket hop is re-issued only under a caller lock — rule 3 (an unlocked source is
  byte-identical, its proxy pick included) outranks the round-2 brief's "any
  different-bucket hop", and A0 stays covered because the Softy hosts are host-owned.
- D13 **"No proxy list resolves" means the operator's list** (second pass, FR-30): the
  resolver sees `EVER_JOBS_CRAWL_PROXIES` / `DEFAULT_PROXIES`, not a plugin's own list or
  a caller's (a lock refuses caller proxies anyway). A plugin with its own proxy list on a
  locked host and no operator list is an accepted edge (none exists today).
- D14 **The effective floor comes from the plugin** (second pass, FR-31): a resolver in
  the metadata, read per API call, rather than the API parsing `SOFTY_*` itself — the
  plugin owns its settings; a resolver that throws falls back to the declared value.
- D15 **The cool-down-first order applies under a lock by default** (PR #105 review, FR-32):
  the race is real for every paced bucket, but the pre-fix order is also the pre-1714
  pacing of every unlocked source, which rule 3 keeps byte-identical; `locked` covers
  every request to `*.softy.pro` (the builtin lock) and every operator lock, and `all`
  is one switch away for an operator who wants it everywhere.
- D16 **Browser redirects stay a documented limitation** (PR #105 review, FR-34): tried
  first — Playwright's routing cannot pause a redirect hop (its handler runs for the
  first URL of a chain only), and the two ways around it (fetching the navigation
  outside the browser, or a Chromium-only CDP session) change every browser navigation
  and are a redesign, not a fix.

## 11. References

- Audit: 35 gaps (G0..G30, K0..K3), 2026-09-26; gap ids are cited per requirement.
- [Spec 1690](../1690-crawl-policy/spec.md), [Spec 1691](../1691-softy-sitemap-discovery/spec.md),
  [Spec 1715](../1715-softy-audit-hardening/spec.md).
- Code: `packages/common/src/http/crawl/{types,defaults,env,policy-schema,resolve,scrape-context,host-limiter,proxy-selector,sitemap}.ts`,
  `packages/common/src/http/http-client.ts`, `packages/models/src/dtos/{crawl-policy,job-post,scrape-diagnostics}.dto.ts`,
  `apps/api/src/jobs/{jobs.service,jobs.controller,health.controller,crawl-policy.mapping,gql-types}.ts`,
  `packages/plugin/src/circuit-breaker/circuit-breaker.service.ts`, `apps/mcp/src/tools.ts`.
