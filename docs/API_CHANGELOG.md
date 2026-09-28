# API Changelog

### [Unreleased] - 2026-09-26, review round 2 2026-09-27 (Specs 1714, 1715)

The operator of the Softy ATS (`*.softy.pro`, one shared server for all its client tenants) asked for an honest User-Agent, one request at a time at about 1 per second, no proxy rotation, back-off on 429 / `Retry-After` and on server errors, and discovery from `/sitemap.xml`. Specs 1690/1691 made those the defaults; an audit (2026-09-26) found request paths that still broke them. These two specs close them; a review of the work (2026-09-27, round 2) closed the paths it found left over (redirect hops, a caller's `resultsWanted`, a caller's timeout on another plugin, nested-sitemap server errors, liveness after cache hits) and made every restore switch restore exactly. Every changed default keeps the old behaviour behind the switch named below. Operator guide: [`CRAWL_POLICY.md`](./CRAWL_POLICY.md).

#### Added

- **Crawl policy fields** `minGapMs` (idle time after a request of a bucket completes before the next one starts, on top of `minIntervalMs`) and `serverErrorCooldownMs` (whole-bucket cool-down after a 500/502/504, a timeout or a connection reset). Both default to `0` (today's behaviour). Settable per request in REST `crawl`, GraphQL `CrawlPolicyInput`, MCP `crawl` and the CLI `--crawl` JSON, and by operators through `EVER_JOBS_CRAWL_MIN_GAP_MS` / `EVER_JOBS_CRAWL_SERVER_ERROR_COOLDOWN_MS` or policy files (Spec 1714).
- **Site-owner caller lock** (Spec 1714): a plugin manifest or a builtin host policy may set `callerOverrides` (`any` \| `stricter` \| `none`). The effective mode for a request is the most restrictive of the global `EVER_JOBS_CRAWL_CALLER_OVERRIDES`, the plugin's lock and any matching builtin host policy's lock; an operator per-site or per-host `callerOverrides` replaces it, looser or tighter. A caller can never send `callerOverrides` (not a DTO field; refused by the resolver).
- **Builtin host policies with `*.suffix` patterns**: `*.softy.pro` and `softy.pro` carry Softy's pacing (`domain` bucket, 1 in flight, 1 s start to start, 0.5 s idle gap, `per-host` proxy pin, 1 retry on 429/503, 10 s throttle floor, 30 s server-error cool-down) and the `stricter` lock, for every request to those hosts whichever source makes it (liveness probes, JSON-LD, ...). Operator `hosts` / `sites` entries still override them.
- **`GET /api/sources/:site/crawl-policy`**: `meta.callerOverrides` is now the effective mode (identical to the global mode for every source without a lock), plus `meta.callerOverridesProvenance` (`default` \| `env-global` \| `builtin-host` \| `plugin` \| `operator-site` \| `operator-host`), `meta.globalCallerOverrides`, `meta.builtinHostPatterns` and `meta.fleetSize`. The top-level policy carries `minGapMs` and `serverErrorCooldownMs`. Fields a lock refuses in a `?crawl=` preview are listed in `meta.caller.rejected`.
- **Job field `jobUrlFetchedAt`** (optional, ISO-8601 UTC; REST JSON and `tool_manifest.json`): the instant the source plugin itself fetched `jobUrl` and parsed a 2xx page during the scrape that produced the record. Unset for cache hits and failures. Softy sets it for the detail pages it fetches (Spec 1715).
- **`liveness.reason`**: `fresh-fetch` on a job that `?liveness=true` marked `active` because its plugin fetched the page during this request (below). Probe verdicts carry no `reason`, as before.
- **`EVER_JOBS_CRAWL_FLEET_SIZE`** (1..1000, default 1): number of processes sharing one egress IP; each process multiplies its start-to-start spacing and `minGapMs` by it, so N replicas together stay within one policy.
- **Softy diagnostics** (Spec 1715): an unknown tenant (NXDOMAIN) answers `bad_input` "unknown Softy tenant" after one DNS lookup and is cached for `SOFTY_UNKNOWN_TENANT_TTL_MS` (default 1 h); a block (401/403/407 or a challenge page) answers `blocked`; a 429/503 answers `rate_limited`; a short result explains itself with a `partial` note.
- **Job field `jobUrlListedAt`** (optional, ISO-8601 UTC; REST JSON and `tool_manifest.json`; round 2): the instant the source's own index that lists the posting (a Softy tenant's `/sitemap.xml`) was fetched from the network, by this search or by an earlier one whose answer the source still caches — the root sitemap's answer time for a sitemap index. It says the posting was listed then, not that `jobUrl` was fetched. Softy sets it on every post taken from a sitemap and, since the second review pass, on every post taken from a list page or the legacy index (that page's answer time; list pages are never cached), so `descriptionDepth: "board"` with `?liveness=true` sends no probe for a board it just read (`SOFTY_LEGACY=listing-no-listed-at` = list-page posts without it). Exported with it: `JOB_LIVENESS_REASON_LISTED = 'listed'` and the type `JobLivenessReason` (`@ever-jobs/models`); `liveness.reason` stays typed `string`.
- **`liveness.reason`: `listed`** (round 2): with `?liveness=true` a job whose `jobUrlListedAt` is at most `EVER_JOBS_LIVENESS_TRUST_LISTED_MAX_AGE_MS` old (default 600000 = 10 min, measured against now, so a search-cache hit counts too) is marked `{ state: "active", checkedAt: <jobUrlListedAt>, reason: "listed" }` without a probe, on the JSON, CSV and NDJSON paths. A fresh fetch still wins (`fresh-fetch`); a future or unparseable time is probed; a trusted job does not count toward `EVER_JOBS_LIVENESS_MAX_URLS`. `0` = off.
- **`GET /api/sources/:site/crawl-policy`** (round 2): `meta.builtinHostsDisabled` (the patterns `EVER_JOBS_CRAWL_BUILTIN_HOSTS_DISABLE` switches off, `[]` by default; `warnings` notes each one skipped for the requested host) and `meta.clientMinIntervalFloorMs` (the spacing floor, ms, the plugin's own client enforces NOW: the plugin's `clientMinIntervalFloor()` in its `@SourcePlugin` metadata, else its declared `clientMinIntervalFloorMs`; `null` when there is none — Softy: `1000`, `null` under `SOFTY_LEGACY=no-interval-floor`), with `meta.clientMinIntervalFloorSwitch` (the switch that removes it, e.g. `SOFTY_LEGACY=no-interval-floor`). No policy layer shortens that floor, so the top-level `minIntervalMs` can read lower than what goes on the wire. Also `meta.switches` — `stricterRules`, `proxyPinScope`, `robotsBackoff`, `paceRedirects`, `callerProxyRotation`, `cooldownBeforeRelease` as in force (the `legacy` preset flips each unless set) — and `meta.proxyPin` `{ scope, keyedOn }`: what the per-host proxy pick of this request keys on (`base` under a caller lock or a site owner's builtin lock, else `bucket`, the pre-1714 pick). The boot-time config mirror (`crawl`) lists the same switches.
- **`EVER_JOBS_CRAWL_PACE_REDIRECTS`** (default `true`; round 2): a redirect hop whose host carries a host-owned policy (a builtin or operator `hosts` entry with a caller lock or `rateLimitScope: "domain"`, e.g. `*.softy.pro`), or that falls in a different rate-limit bucket while the request or the hop is under a caller lock, is re-issued as a request of its own — its own limiter slot, lock, robots.txt, proxy pick, cool-down check and retries — instead of being followed inside the first request's slot. Every other hop is followed in the slot as before, so a source without a lock keeps one slot and one proxy on a cross-host chain (the pre-1714 behaviour, byte for byte). Method, dropped headers and `auth` change as follow-redirects would change them; the chain is capped at the request's `maxRedirects` (unset: 21), and a re-issued hop never answers from the multi-location memo, so a redirect loop fails with `ERR_FR_TOO_MANY_REDIRECTS` instead of waiting on itself. `HttpClient` only: a redirect inside a browser navigation (`BrowserPool.navigate`) still runs under the first URL's policy, a documented limitation (`CRAWL_POLICY.md` §9; Playwright routes only the first URL of a redirect chain). `false` = the pre-fix in-slot follow.
- **`EVER_JOBS_CRAWL_CALLER_PROXY_ROTATION`** (`base` \| `ranked`, default `base`; `ranked` under the `legacy` preset; round 2): under a `stricter` caller mode (a site owner's lock such as Softy's, or the operator's) and the `1714` comparators, a caller's `proxyRotation` is accepted only when it equals the resolved value, or is `off` while no proxy list is configured (`EVER_JOBS_CRAWL_PROXIES` / `DEFAULT_PROXIES` empty, when `off` changes nothing on the wire). A caller can no longer send `off` to take its Softy requests off the operator's pinned proxy (a second origin for Softy). `ranked` restores the order `off` < `per-host` < `per-scrape` < `per-request` (accept ≤ base).
- **`EVER_JOBS_CRAWL_COOLDOWN_BEFORE_RELEASE`** (`locked` \| `all` \| `off`, default `locked`; `off` under the `legacy` preset; review of PR #105): a failed request used to free its limiter slot before it recorded the failure, so a request queued behind a `429`, `503` or struggling server could be granted and sent inside the cool-down being set. Under `locked` a request under a lock (a caller lock, or a site owner's builtin host lock: every request to `*.softy.pro`) records the outcome and cool-down first; every other request keeps the old order (a source without a lock is unchanged); `all` applies it to every request; `off` restores the old order everywhere. Shown in `meta.switches.cooldownBeforeRelease` and the config mirror.
- **`EVER_JOBS_CRAWL_BUILTIN_HOSTS_DISABLE`** (default empty; round 2): a comma list of builtin host patterns to skip, e.g. `*.softy.pro,softy.pro`, so other plugins and liveness probes reach Softy's hosts under the generic defaults again while the Greenhouse / Lever / Ashby / SmartRecruiters builtin limits stay. Unknown patterns are ignored with a warning.
- **`EVER_JOBS_LIVENESS_TRUST_LISTED_MAX_AGE_MS`** (default `600000`; `0` = off; round 2): see `liveness.reason: listed` above. A non-negative integer; anything else keeps the default and is logged once.
- **`SOFTY_LEGACY` tokens** (round 2): `caller-listing`, `nested-skip`, `legacy-detail-url`, `first-error`, `listing-no-listed-at`, `empty-board-uncached` (below); part of `all`.

#### Changed

- **Callers can no longer make Softy traffic less polite on a default install** (Specs 1714/1715). Under the Softy lock (`stricter`) a search caller's `crawl` fields are accepted only when at least as polite as the resolved policy: no browser or plugin User-Agent, no `from`, no shorter interval or gap, no higher concurrency, no other proxy rotation than the resolved `per-host` (not even `off` while the operator configured proxies: that would move the caller's Softy requests to another origin), no parallel rate-limit bucket (`site` next to `domain`), no weaker retry / `Retry-After` handling, no list pages instead of the sitemap. Refused fields are dropped for that source (the `?crawl=` preview of the policy endpoint lists them). Other sources behave exactly as before under the default `any`. The operator undoes the lock with `EVER_JOBS_CRAWL_POLICIES={"sites":{"softy":{"callerOverrides":"any"}},"hosts":{"*.softy.pro":{"callerOverrides":"any"},"softy.pro":{"callerOverrides":"any"}}}` (or, bluntly, `EVER_JOBS_CRAWL_PLUGIN_MANIFESTS=false` plus `EVER_JOBS_CRAWL_BUILTIN_HOSTS=false`).
- **`stricter` is stricter** (every source, when the operator chose `stricter` or a lock applies): `rateLimitScope` may only move `host` → `domain`; `proxyRotation` must equal the resolved value, or be `off` while no proxy list is configured (round 2; `EVER_JOBS_CRAWL_CALLER_PROXY_ROTATION=ranked` restores the round-1 order `off` < `per-host` < `per-scrape` < `per-request`); `retryStatuses` must keep the base's 429/503 and may add only 429/503; `discovery` may only move to `sitemap`. `EVER_JOBS_CRAWL_STRICTER_RULES=1690` restores the Spec 1690 comparators.
- **`requestTimeout` is gated** by the source's effective caller mode: under `stricter` only a value ≥ 60 s is kept (else 60 s), under `none` it is ignored (60 s), under `any` it passes unchanged. Applied once per source in `JobsService`, which REST, GraphQL, MCP (through REST) and the CLI all reach. Round 2: `HttpClient` also gates a caller's timeout **per request host** with that host's mode, so a caller's timeout on a request to a locked host (`*.softy.pro`) made by an unlocked plugin goes out as 60 s, and a caller's timeout under 60 s that fires never counts as a struggling server (no `serverErrorCooldownMs` cool-down of the host). It recognises the caller's timeout on a client built from the search DTO, or one equal to the new `ScrapeContext.callerRequestTimeout`, which `JobsService` fills with the gated `requestTimeout` of every source (Spec 1714 T26, commit d235e9df) — so a plugin that copies `requestTimeout` into its own `timeout` option, like JSON-LD, is covered too. `EVER_JOBS_CRAWL_STRICTER_RULES=1690` leaves it ungated everywhere.
- **Caller `proxies` under a lock**: ignored for a locked source or host (the operator's `EVER_JOBS_CRAWL_PROXIES` still apply); a search whose proxies a lock refuses logs one warning naming the sources. An operator per-site / per-host `callerOverrides: "any"` gives them back. Sources without a lock: `EVER_JOBS_CRAWL_CALLER_PROXIES` decides exactly as before.
- **Per-host proxy pick** keys on the registrable domain whenever the site's own scope is `domain` **and** the request is under a caller lock (effective mode not `any`) or on a host whose builtin policy carries a site owner's lock (`*.softy.pro`), so a caller setting can never split one site's tenants across proxies. Round 2: every other request — a source without a lock under `any`, even with a `domain` scope from the preset or env — keeps the pre-1714 pick byte for byte (golden test). `EVER_JOBS_CRAWL_PROXY_PIN_SCOPE=bucket` restores the pre-1714 pick everywhere.
- **Multi-location search stops on 503**: a source answering 503 (thrown, or a `fetch_error` diagnostic naming 503 / "Service Unavailable") is not asked for its remaining locations (rows `not attempted`), like 429, `rate_limited`, `blocked` and an open circuit. `EVER_JOBS_SEARCH_STOP_ON_503=false` restores the old loop.
- **Circuit breaker counts refused empty results**: a scrape that resolves with 0 jobs and a `rate_limited` or `blocked` diagnostic counts as a breaker failure (the result is still returned; `lastError.code` `ERR_SOURCE_REFUSED`), so a plugin that swallows its refusals can still trip after 5 in a row. `EVER_JOBS_BREAKER_COUNT_REFUSALS=false` restores the old rule (every resolved call is a success).
- **`?liveness=true` trusts a fresh plugin fetch**: a job whose `jobUrlFetchedAt` is not older than the start of the request is marked `{ state: "active", checkedAt: <jobUrlFetchedAt>, reason: "fresh-fetch" }` without a second GET; a search-cache hit never counts as fresh, and a fetch time later than now is not trusted (the job is probed, like a future `jobUrlListedAt`; review of PR #105). Probes of `*.softy.pro` URLs now run under the Softy host policy. `EVER_JOBS_LIVENESS_TRUST_FRESH_FETCH=false` probes every URL, as before.
- **Fresh-fetch trust and the Spec 1721 / 1723 liveness controls**: the trust applies to JSON, CSV and `?format=ndjson` alike (the stream counts from its own start and trusts nothing on a cache hit), and a trusted job does not count toward `EVER_JOBS_LIVENESS_MAX_URLS`, which caps only the probes actually sent (the first N of the jobs still needing one). With `EVER_JOBS_LIVENESS_TRUST_FRESH_FETCH=false` the cap takes the first N jobs in output order, as in Spec 1723.
- **Server errors and robots.txt feed the host limiter**: with `serverErrorCooldownMs` > 0 a 500/502/504, timeout or reset cools the whole bucket; a robots.txt 429/503/`Retry-After`/5xx is handled like any page answer (`EVER_JOBS_CRAWL_ROBOTS_BACKOFF=false` = pre-1714). A nested sitemap answering 429/503 (or a crawl-policy refusal) stops the sitemap walk (`fetchSitemap` option `nestedErrors: 'skip'` = pre-1714; for Softy, `SOFTY_LEGACY=nested-skip` or `SOFTY_SITEMAP_FALLBACK=any-error` sets it).
- **The `legacy` preset restores the pre-1714 defaults of the new switches** (round 2): unset, `EVER_JOBS_CRAWL_STRICTER_RULES` is `1690`, `EVER_JOBS_CRAWL_PROXY_PIN_SCOPE` `bucket`, `EVER_JOBS_CRAWL_ROBOTS_BACKOFF` and `EVER_JOBS_CRAWL_PACE_REDIRECTS` `false`, `EVER_JOBS_CRAWL_CALLER_PROXY_ROTATION` `ranked`, `EVER_JOBS_CRAWL_COOLDOWN_BEFORE_RELEASE` `off`, `EVER_JOBS_BREAKER_COUNT_REFUSALS`, `EVER_JOBS_SEARCH_STOP_ON_503` and `EVER_JOBS_LIVENESS_TRUST_FRESH_FETCH` `false`, `EVER_JOBS_LIVENESS_TRUST_LISTED_MAX_AGE_MS` `0` under `EVER_JOBS_CRAWL_PRESET=legacy` (the preset read with the crawl layer's spelling rules). An explicit value still wins. `legacy` does not touch `EVER_JOBS_CRAWL_ABORT_ON_DEADLINE`, `EVER_JOBS_CIRCUIT_MAX_SITES` or a plugin's own settings (`SOFTY_*`, the Softy client floor): `CRAWL_POLICY.md` §16 lists them.
- **Invalid API switch values are reported** (round 2): an unrecognised `EVER_JOBS_SEARCH_STOP_ON_503`, `EVER_JOBS_LIVENESS_TRUST_FRESH_FETCH` or `EVER_JOBS_LIVENESS_TRUST_LISTED_MAX_AGE_MS` keeps its default and is logged once per variable and value, naming the value used (they were silently ignored); the breaker's warning for `EVER_JOBS_BREAKER_COUNT_REFUSALS` names the value it uses.
- **Softy source** (Spec 1715): discovery falls back from the sitemap to list pages only when the sitemap answered 2xx but held no offer or could not be parsed (`SOFTY_SITEMAP_FALLBACK=any-error` = pre-1715; `missing` also falls back on 404/410); push-back (401/403/407, a challenge page, 429, 503, a nested-sitemap throttle) stops the whole scrape with a diagnostic; one consecutive detail failure stops it (`SOFTY_MAX_CONSECUTIVE_DETAIL_FAILURES=3` = pre-1715); detail GETs are capped at `resultsWanted + SOFTY_DETAIL_ATTEMPT_SLACK` (5); the sitemap is cached per tenant for `SOFTY_SITEMAP_CACHE_TTL_MS` (10 min; 0 = off); sitemap detail-cache entries (keyed by `lastmod`) no longer expire (`SOFTY_DETAIL_CACHE_TTL_MS=21600000` = pre-1715); offer ids are de-duplicated; `offset` no longer counts against the detail budget; an operator `discovery: "sitemap"` wins over `descriptionDepth: "board"`; `SOFTY_MAX_LIST_PAGES=0` disables list pages; the legacy index is requested at `/offers` (no unpaced redirect hop); the client keeps a 1 s interval floor. Round 2: under the caller lock, a detail budget smaller than `resultsWanted` (`detail-25`, or more than `SOFTY_MAX_DETAIL_FETCHES`) stays on the sitemap and returns what the budget allows with a `partial` note instead of reading list pages (an operator `auto`, a lifted lock, `SOFTY_MAX_DETAIL_FETCHES=0` or `SOFTY_LEGACY=caller-listing` keep the listing; `descriptionDepth: "board"` still reads list pages — one page per 21 offers is fewer requests than the sitemap plus a detail page each); a nested sitemap answering 500/502/504, timing out or resetting stops the scrape with `fetch_error` / `timeout`, like the root sitemap (`SOFTY_LEGACY=nested-skip` or `SOFTY_SITEMAP_FALLBACK=any-error` skip every nested failure, as before); legacy cards link `/offers/{ID}` instead of the redirecting `/offre/{ID}-{slug}` (`SOFTY_LEGACY=legacy-detail-url`). Second review pass: list-page and legacy-index posts carry `jobUrlListedAt` (`SOFTY_LEGACY=listing-no-listed-at`); a tenant with no open offer — its sitemap lists none and the fallback listing finds no card — is remembered for `SOFTY_SITEMAP_CACHE_TTL_MS`, so a repeat search sends nothing (`SOFTY_LEGACY=empty-board-uncached`, or `SOFTY_SITEMAP_CACHE_TTL_MS=0`); `SOFTY_LEGACY=first-error` restores the pre-1715 diagnostics (the first error, classified: a later 429 or robots.txt refusal no longer replaces an earlier 5xx, and a 429 reads `fetch_error` — so a multi-location search goes on to the next location and the breaker does not count it). `SOFTY_SITEMAP_FALLBACK=any-error` restores the pre-1715 sitemap-stage decisions, not the crawl policy (a recipe in `CRAWL_POLICY.md` §16 does that). `SOFTY_LEGACY` (`offset-budget`, `duplicate-ids`, `board-over-sitemap`, `offres`, `block-as-missing`, `503-as-failure`, `listing-failure-details`, `no-interval-floor`, `caller-listing`, `nested-skip`, `legacy-detail-url`, `first-error`, `listing-no-listed-at`, `empty-board-uncached`, or `all`) restores single pre-1715 behaviours.
- **CI**: the live Softy e2e runs only on the weekly schedule, on manual dispatch, or with `EVER_JOBS_LIVE_SOFTY=1`; on push and PR it is skipped with a visible reason (Spec 1715). The new `schedule` / `workflow_dispatch` triggers apply to the whole CI workflow, so every other job also runs once a week.
- **Docs**: the README has a "For website operators" section, linked from its first lines (where the UA's `+https://github.com/ever-jobs/ever-jobs` lands): what `EverJobs/1.0` means, the default pace, that many people self-host it, how to reach the project and how a site can get a site-owner policy like Softy's.

#### Restore switches (pre-1714 / pre-1715 behaviour)

| Change | Restore with |
|---|---|
| Softy lock (plugin manifest and builtin `*.softy.pro` / `softy.pro`): callers may change every Softy field again | operator `callerOverrides: "any"` for `sites.softy`, `hosts["*.softy.pro"]`, `hosts["softy.pro"]`, **plus `SOFTY_LEGACY=no-interval-floor`** (the Softy client's 1 s floor, which no policy layer lifts) |
| Softy's pacing and lock for other plugins and liveness probes (the builtin `*.softy.pro` / `softy.pro` entries only) | `EVER_JOBS_CRAWL_BUILTIN_HOSTS_DISABLE=*.softy.pro,softy.pro` — the Greenhouse / Lever / Ashby / SmartRecruiters limits that predate Spec 1714 stay |
| The whole builtin host layer (bulk-API limits too) | `EVER_JOBS_CRAWL_BUILTIN_HOSTS=false` (not a pre-1714 state: it also drops the pre-1714 bulk-API limits) |
| The pre-1715 Softy crawl policy (manifest retries, back-off, idle gap, cool-down, UA mode, client floor, lock) | the operator recipe in `CRAWL_POLICY.md` §16: `EVER_JOBS_CRAWL_BUILTIN_HOSTS_DISABLE=*.softy.pro,softy.pro`, `SOFTY_LEGACY=no-interval-floor`, and a `sites.softy` entry with the preset's values |
| `stricter` comparators and `requestTimeout` gating (per source and per host), caller short timeouts not cooling a host | `EVER_JOBS_CRAWL_STRICTER_RULES=1690` |
| A `stricter` caller's `proxyRotation` must equal the resolved value (`off` only without a proxy list) | `EVER_JOBS_CRAWL_CALLER_PROXY_ROTATION=ranked` (the round-1 order; `1690` rules keep their own) |
| A failed request under a lock records its cool-down before freeing its slot | `EVER_JOBS_CRAWL_COOLDOWN_BEFORE_RELEASE=off` (a source without a lock already keeps the old order under the default `locked`) |
| Per-host proxy pick on the registrable domain | `EVER_JOBS_CRAWL_PROXY_PIN_SCOPE=bucket` |
| robots.txt answers feed the limiter | `EVER_JOBS_CRAWL_ROBOTS_BACKOFF=false` |
| Redirect hops re-issued under their own policy (a host-owned policy, or a cross-bucket hop under a caller lock) | `EVER_JOBS_CRAWL_PACE_REDIRECTS=false` |
| Nested sitemap stops on push-back (and, for Softy, on a server error) | Softy: `SOFTY_LEGACY=nested-skip` or `SOFTY_SITEMAP_FALLBACK=any-error`; other plugins: `fetchSitemap({ nestedErrors: 'skip' })` (code option) |
| Multi-location stop on 503 | `EVER_JOBS_SEARCH_STOP_ON_503=false` |
| Breaker counts refused empty results | `EVER_JOBS_BREAKER_COUNT_REFUSALS=false` |
| Liveness trusts a fresh plugin fetch / a recent listing | `EVER_JOBS_LIVENESS_TRUST_FRESH_FETCH=false` / `EVER_JOBS_LIVENESS_TRUST_LISTED_MAX_AGE_MS=0` (both, to probe every URL) |
| The `EVER_JOBS_*` rows above at once, with the whole builtin host layer and every plugin manifest off (not the `SOFTY_*` rows, nor the Softy client floor) | `EVER_JOBS_CRAWL_PRESET=legacy` (explicit values still win) |
| `minGapMs`, `serverErrorCooldownMs`, fleet size | `0`, `0`, `1` (the defaults) |
| Softy sitemap fallback, detail-failure stop, attempt cap, sitemap cache, detail-cache TTL, unknown-tenant cache | `SOFTY_SITEMAP_FALLBACK=any-error`, `SOFTY_MAX_CONSECUTIVE_DETAIL_FAILURES=3`, `SOFTY_DETAIL_ATTEMPT_SLACK=100`, `SOFTY_SITEMAP_CACHE_TTL_MS=0`, `SOFTY_DETAIL_CACHE_TTL_MS=21600000`, `SOFTY_UNKNOWN_TENANT_TTL_MS=0` |
| Softy: a caller's short detail budget reads list pages; `/offre/{ID}-{slug}` detail links | `SOFTY_LEGACY=caller-listing`; `SOFTY_LEGACY=legacy-detail-url` |
| Softy: the pre-1715 diagnostics (first error kept, a 429 / crawl-policy hold-back names no reason itself) | `SOFTY_LEGACY=first-error` |
| Softy: list-page posts without `jobUrlListedAt` (liveness probes them); a tenant without offers asked again every search | `SOFTY_LEGACY=listing-no-listed-at`; `SOFTY_LEGACY=empty-board-uncached` (or `SOFTY_SITEMAP_CACHE_TTL_MS=0`) |
| Other Softy behaviours | `SOFTY_LEGACY=<token>[,<token>...]` or `SOFTY_LEGACY=all` |

Open questions with the defaults the build proceeds with: [Q-120..Q-128](./questions.md) (Q-126: the caller-override default for every other source; Q-127: fleet size and a crawler contact in our own deployments; Q-128: Softy's retry and back-off numbers).

### [Unreleased] - 2026-09-25 (Specs 1692-1713)

#### Added

- **Multi-location search** (`POST /api/jobs/search`, `/analyze`, GraphQL `searchJobs`, CLI `--locations`, MCP `locations`): `locations: string[]` (up to 25; the first `EVER_JOBS_SEARCH_MAX_LOCATIONS`, default 10, are searched and the rest come back as `bad_input` rows in `perSource`). Each source runs once per location, one after another, with its own `resultsWanted` / `offset`; same-source duplicates are removed. Each source's location loop runs in a scoped response memo, so a source that fetches its whole board costs one fetch for N locations (`EVER_JOBS_SEARCH_LOCATION_MEMO=off` / `get`), and consecutive location calls wait the larger of `EVER_JOBS_SEARCH_LOCATION_INTERVAL_MS` and the plugin's own request gap. Without `locations` the request behaves exactly as before (Spec 1700).
- **Exclusion filters**: `excludeTitleTerms`, `excludeKeywords` and `excludePresets` (`security_clearance`). Whole-word, case- and accent-insensitive, negation-aware literal matching (trailing `*` = prefix, never a regex), applied after dedup; the cache and stored corpus are unaffected (Spec 1700).
- **`linkedinFetchCompanyDetails`** input flag (CLI `--linkedin-fetch-company-details`): opt-in LinkedIn company enrichment; unset = `EVER_JOBS_LINKEDIN_FETCH_COMPANY_DETAILS` (Spec 1701).
- **Job fields** (REST JSON; GraphQL selection is a follow-up): `datePostedAt`, `datePostedPrecision`, `datePostedBasis` (Spec 1696), `companySourceId`, `applicantsCount`, `applicantsCountBound` (Spec 1701), `aiLevel` (Spec 1693). Absent unless a source provides them.
- **Posted-time fields on every surface** (Spec 1696): GraphQL `JobPost.datePostedAt`, `datePostedPrecision`, `datePostedBasis` (nullable `String`s carrying the REST values, e.g. `minute`); the MCP `search_jobs`, `search_remote_jobs` and `get_job_details` results gain `date_posted_at`, `date_posted_precision`, `date_posted_basis` after `date_posted`, present only when the source gave them; the CLI CSV gains the three columns after `description` (earlier columns keep their positions) and the table a trailing `Posted at (UTC)` column; the tool manifest's output schema lists them. `EVER_JOBS_POSTED_TIME_DETAIL=false` still removes them everywhere.
- **Sources**: `inhire` (ATS, Spec 1692), `jobsbylevel` (Spec 1693), `simplifyjobs` (Spec 1694).
- **Job types**: `permanent` and `apprenticeship` (Spec 1697).

#### Changed

- Same-site results are ordered by the posting instant when a source gives one (`datePostedAt`), else by `datePosted`; an unparseable date sorts last (Spec 1696).
- Salary post-processing: a single direct bound counts as direct data, a compensation without an amount no longer blocks the USA description fallback, and `enforceAnnualSalary` annualises single bounds. The description fallback reads an upper-only figure only when a salary word precedes it in its clause and no benefit word does (`relocation up to $10,000` is not a salary). The salary parser also reads pay-period tokens and `to` ranges, but a benefit range (`Sign-on bonus of $2,000 to $5,000`) never shadows the salary after it. `EVER_JOBS_SALARY_GRAMMAR=legacy` restores the earlier rules (Spec 1695).
- Board plugins (LinkedIn, Indeed, Glassdoor, Google, Welcome to the Jungle, Internshala, RemoteOK, Wellfound, Solid.Jobs, Bayt, BDJobs, Naukri, ZipRecruiter) report a block, challenge or unsupported region as a `perSource` diagnostic instead of an empty result. The new sources and the rewritten detail walks (InHire, Level, Internshala) stop at the first refusal (429, 401/403/407, a challenge page) and return what they have with that diagnostic.
- **Job ids change once** for several boards. Postings already in a stored corpus, the search cache or a client's saved references reappear under the new id once after deploy, so expect a one-time spike of apparent new postings (the cross-source dedup still merges them by title, company and location). The switches restore the old ids:

  | Board | Old id | New id | Restore |
  |---|---|---|---|
  | LinkedIn (1701) | `li-<url slug with id>` | `li-<digits>` | `EVER_JOBS_LINKEDIN_LEGACY=ids` |
  | Glassdoor (1703) | `gd-<adOrderId>` (shared by several listings) | `gd-<listingId>` | `EVER_JOBS_GLASSDOOR_LEGACY=ids` |
  | Google (1704) | `go-<url hash>` | `go-<record id>` (url hash when the record has none) | `EVER_JOBS_GOOGLE_LEGACY_PARSER=true` |
  | Internshala (1706) | `is-<url hash>` | `is-<posting id>` | `INTERNSHALA_ID_SCHEME=url-hash` |
  | Bayt (1710) | `bayt-<url hash>` (changed with the query string) | `bayt-<job id>` | `EVER_JOBS_BAYT_LEGACY_MAPPING=true` |
  | BDJobs (1711) | the `jobid=` URL parameter, else `bdjobs-<url hash>` | the API `Jobid` (same id space) | `BDJOBS_MODE=html` |
  | ZipRecruiter (1713) | `zr-<job_id>` | `zr-<listing_key>` | none: the API no longer sends `job_id`, so the old ids yielded zero rows |

- **Legacy switches, exactly.** Each spec's switch in `.env.example` restores the earlier behaviour, with these exceptions, each because the old behaviour was the defect:
  - Glassdoor (1703): the old pagination loop (it never ended on a board that ignores the cursor) cannot come back; every other change has an `EVER_JOBS_GLASSDOOR_LEGACY` name.
  - ZipRecruiter (1713): `ZIPRECRUITER_LEGACY_PARAMS=true` restores the old query and session event, but not the old ids (above), `jobUrl = job.job_url`, or rows with an empty `jobUrl` (dropped, spec D-08).
  - Internshala (1706): `INTERNSHALA_DEFAULT_STREAMS=job` and `INTERNSHALA_ID_SCHEME=url-hash` restore the streams and ids; the old search URLs (not site routes), card selectors (a card was emitted twice) and whole-card remote detection (read `WFH` in a snippet as remote) are not kept. The `Apply by:` line is still added when a card shows a deadline.
  - BDJobs (1711): `BDJOBS_MODE=html` runs the legacy HTML path patched for politeness (honest User-Agent, page cap, seen-id check before the detail fetch, date parsing), not the pre-1711 code verbatim.
- **Country names** (Spec 1699): with `EVER_JOBS_LOCATION_ISO_COUNTRY_NAMES` on (the default), an upper-case alpha-3 code emits the same CLDR name as the country's name and alpha-2 code already did, so `HKG` reads `Hong Kong SAR China` (was `Hong Kong`), `TUR` reads `Türkiye` (was `Turkey`) and `CZE` reads `Czechia` (was `Czech Republic`). Filters or saved searches that match the old alpha-3 spellings should match the CLDR ones; the names come from the runtime's ICU data. `EVER_JOBS_LOCATION_ISO_COUNTRY_NAMES=false` restores the old spellings.
- **Welcome to the Jungle** (1705): the whole-index board search in `scrape()` is opt-in (`WTTJ_BOARD_MODE=on`) until the owner rules on Q-099; company boards work as before.
- **ZipRecruiter** (1713): the session event stays the pre-1713 JSON body without a cookie jar; the app-shaped form-encoded event is opt-in (`ZIPRECRUITER_SESSION_EVENT=form`), and `off` sends none. With the crawl policy the desktop User-Agent in the plugin's headers is only declared, so our configured (honest) User-Agent goes out by default; `EVER_JOBS_CRAWL_POLICIES={"sites":{"zip_recruiter":{"userAgentMode":"plugin"}}}` sends the declared one.
- **RemoteOK** (1707): sends our identifying User-Agent; `EVER_JOBS_REMOTEOK_LEGACY=ua` restores the browser one. With the crawl policy the switch also opts the plugin into `userAgentMode: "plugin"`, so it works under the default `identify` mode; `EVER_JOBS_CRAWL_USER_AGENT_MODE=strict` still sends the configured User-Agent. The same holds for Welcome to the Jungle's `WTTJ_USER_AGENT_MODE=browser` (1705).
- **Google** (1704): `EVER_JOBS_GOOGLE_MAX_PAGES` is clamped to 30.
- **With the crawl policy** (Specs 1690/1691, next entry): every per-location call of a multi-location search runs in its own scrape context (the plugin's crawl manifest, the caller's `crawl`, the search deadline's abort signal), a response-memo hit sends nothing and takes no rate-limit slot, and a `rate_limited` answer (a host cooling down, or no slot in time) stops that source's remaining locations like a 429 does. The location pause (`EVER_JOBS_SEARCH_LOCATION_INTERVAL_MS`) stays on top of the per-host limiter. A caller's `rateDelayMin` / `crawl.minIntervalMs` cannot go below the minimum spacing RemoteOK (1 s, its robots.txt `Crawl-delay`), Welcome to the Jungle (0.5 s) and Simplify (2 s) keep (`minIntervalFloorMs` on their clients); it can still lengthen it. A request waiting on an identical in-flight one in the memo is cancelled by its own abort signal.

### [Unreleased] - 2026-09-25 (Specs 1690, 1691)

#### Added

- **`crawl` on `POST /api/jobs/search` and `POST /api/jobs/analyze`** (`ScraperInputDto.crawl`, `CrawlPolicyDto`): an optional per-request crawl policy — `userAgent`, `userAgentMode`, `from`, `stripClientHints`, `proxyRotation`, `rateLimitScope`, `maxConcurrentPerHost`, `minIntervalMs`, `jitterMs`, `maxQueueWaitMs`, `adaptiveThrottle`, `retries` (0–10), `retryStatuses`, `retryBackoff`, `retryBaseDelayMs`, `retryMaxDelayMs`, `retryJitter`, `retryOnNetworkError`, `respectRetryAfter`, `maxRetryAfterMs`, `retryAfterOverMax`, `throttleRetryDelayMs`, `robotsTxt`, `blockPrivateNetworks`, `discovery`. Every field optional and validated; the operator decides how much a caller may change (`EVER_JOBS_CRAWL_CALLER_OVERRIDES` = `any` | `stricter` | `none`); `blockPrivateNetworks` can only be turned on by a caller. See [CRAWL_POLICY.md](./CRAWL_POLICY.md).
- **GraphQL:** `SearchJobsInput.crawl` of the new input type `CrawlPolicyInput` (same fields; enum-like fields are `String`s).
- **MCP:** `search_jobs` accepts `crawl` (object or JSON-object string).
- **CLI:** `search` and `compare` accept `--crawl <json>`, `--user-agent-mode`, `--proxy-rotation`, `--max-per-host`, `--min-interval-ms`, `--crawl-retries`, `--robots-txt`, `--discovery`, and the process-wide `--crawl-preset`, `--caller-overrides`.
- **`GET /api/sources/:site/crawl-policy?host=&crawl=`**: the resolved crawl policy of a source (optionally for one host, optionally previewing a caller override) with the layer that set each field (`provenance`), the plugin's `userAgentReason`, operator-policy matches and configuration warnings (credentials redacted). 404 for an unknown site, 400 for an unparseable `host`/`crawl`.
- **Diagnostics:** new per-source reason **`rate_limited`** (actionable): our own crawl policy held the source back — no slot within `maxQueueWaitMs`, or the host asked us to back off (`Retry-After`) for longer than we wait. robots.txt refusals report `blocked`; private/internal destinations report `bad_input`.
- **Environment:** 47 `EVER_JOBS_CRAWL_*` variables (preset, identity, proxies, pacing, retries, robots.txt, egress guard, discovery, operator per-site/per-host JSON policies, caller rules), `EVER_JOBS_CIRCUIT_MAX_SITES`, `EVER_JOBS_LIVENESS_DEADLINE_MS`, and `SOFTY_*` knobs — all listed in [CRAWL_POLICY.md §5](./CRAWL_POLICY.md#5-environment-variables) and `.env.example`.

#### Changed

- **Outbound identity:** by default every request carries `Mozilla/5.0 (compatible; EverJobs/1.0; +https://github.com/ever-jobs/ever-jobs)` instead of a desktop Chrome UA; plugins send their own UA only with a stated reason (USAJobs, HeadHunter). `EVER_JOBS_CRAWL_PRESET=legacy` (or `EVER_JOBS_CRAWL_USER_AGENT=browser`) restores the old identity.
- **Pacing:** requests are paced per host process-wide (default 4 in flight, 100 ms between starts; higher builtin limits for the Greenhouse, Lever, Ashby and SmartRecruiters APIs). `rateDelayMin`/`rateDelayMax` now space concurrent requests too (per host bucket).
- **Proxies:** default rotation is one stable proxy per host (`per-host`) instead of round-robin per request; `DEFAULT_PROXIES` is now used as the fallback list.
- **Retries:** default 2 retries on `429,502,503,504` with exponential back-off and jitter (was 3 linear on `429,500,502,503,504`); never earlier than `Retry-After`; a `Retry-After` over 60 s gives up and cools the whole host instead of being cut to 30 s.
- **Legacy flat fields** (`userAgent`, `rateDelayMin`/`Max`, `retries`, `retryDelay`, `retryBackoff`, `retryMaxDelay`) map into the caller layer only when sent; a sent `userAgent` implies `userAgentMode: "strict"`. `crawl` wins over them.
- **Search deadline:** an abandoned source's queued and in-flight requests are cancelled (`EVER_JOBS_CRAWL_ABORT_ON_DEADLINE=false` restores the old behaviour); such aborts no longer count against the source's circuit breaker, which now tracks up to 4,096 sites (was 250).
- **Egress guard:** requests to loopback / private / link-local / cluster-internal destinations are refused by default (`EVER_JOBS_CRAWL_BLOCK_PRIVATE_NETWORKS=false` or `EVER_JOBS_CRAWL_EGRESS_ALLOW_HOSTS` for local mocks).
- **Softy (`softy`):** works on the current `/offers` markup again, discovers offers from `/sitemap.xml` (`crawl.discovery` = `auto` | `sitemap` | `listing`), reads paginated listings, fetches detail pages one at a time at ~1 req/s across `softy.pro`.

#### Fixed

- **MCP `search_jobs`** posted snake_case keys that the API's validation whitelist stripped, so every MCP search ran as an unfiltered whole-catalogue fan-out; it now posts the camelCase fields the API accepts.
- **Plugin-declared User-Agents** (e.g. USAJobs' required registered e-mail) were silently replaced by the client's default UA; they now reach the wire where the resolved mode allows.
- `createHttpClient` no longer drops a plugin's own `timeout` when proxies are set.

---

### [v0.7.0-alpha] - 2026-07-27

#### Added

- **`companyDomain` parameter on `POST /api/jobs/search` and `POST /api/jobs/analyze`**: optional array of company domains that are resolved to registered `Site` tokens using the Spec 5069 domain-to-token rule. Unresolved domains now return HTTP 400 with the domain and derived token in the error message.

#### Changed

- `siteType` no longer defaults to all registered sources in `ScraperInputDto`; omitting both `siteType` and `companyDomain` still falls back to search + company scrapers (ATS scrapers skipped unless `companySlug` is provided).

---

### [v0.6.0-alpha] - 2026-02-25

#### Added

- **Redis-Backed Caching**: Optional Redis support via `REDIS_URL`. Falls back to in-memory if not configured.
- **GraphQL API**: New endpoint at `/graphql` (configurable path) with Apollo Playground.
- **Prometheus Metrics**: Export application metrics at `/metrics` for Prometheus scraping.
- **Retry Policies**: Configurable retries with linear and exponential backoff strategies for all job scrapers.
- **Plugin Architecture**: Runtime loading of community scrapers from a `plugins/` directory.
- **Expanded Sources**: Integrated JobsDB and Techcareers sources.

#### Changed

- `AppCacheModule` now uses `registerAsync` for dynamic configuration.
- `JobsService` now supports dynamic scraper registration.
- `HttpClient` standardizes request handling with built-in retries.

New environment variables: `REDIS_URL`, `CACHE_MAX_ITEMS`.

A full GraphQL API is now available alongside REST at `/graphql`:

- **Queries:** `searchJobs`, `listSources`
- **Apollo Playground** enabled by default (configurable via `ENABLE_GRAPHQL`, `GRAPHQL_PLAYGROUND`, `GRAPHQL_PATH`)
- Code-first schema generation with auto-introspection

New dependencies: `@nestjs/graphql`, `@nestjs/apollo`, `@apollo/server`, `graphql`, `cache-manager`, `cache-manager-redis-yet`, `prom-client`.

---

## [1.1.0] — 2026-02-25

### Phase 27: Asia-Pacific & US Tech Expansion (2 sources)

**JobsDB** (Asia-Pacific — SG, HK, TH) and **TechCareers** (US tech niche)

Total sources expanded from 158 to 160.

### New `siteType` Values

`jobsdb`, `techcareers`

---

## [1.0.0] — 2026-02-25

### Phases 23–26: Global & Niche Expansion (14 sources)

**Phase 23 — Japan, Nordic & Swiss (3):** Jobs in Japan, Duunitori (Finland), Jobs.ch (Switzerland)
**Phase 24 — UK & Mobile Dev (3):** Guardian Jobs, AndroidJobs, iOSDevJobs
**Phase 25 — DevOps, FP & Diversity (4):** DevOpsJobs, FunctionalWorks, PowerToFly, ClojureJobs
**Phase 26 — Sustainability (1):** EcoJobs

Total sources expanded from 144 to 158.

### New `siteType` Values

`jobsinjapan`, `duunitori`, `jobsch`, `guardianjobs`, `androidjobs`, `iosdevjobs`, `devopsjobs`, `functionalworks`, `powertofly`, `clojurejobs`, `ecojobs`

## [0.9.0] — 2026-02-22

### Phases 19–22: European & CIS Expansion (18 sources)

**Phase 19 — Tech niche & crypto (5):** RailsJobs, ElixirJobs, Crunchboard, CryptocurrencyJobs, HasJob
**Phase 20 — European regional (5):** iCrunchdata, SwissDevJobs, GermanTechJobs, VirtualVocations, NoFluffJobs
**Phase 21 — Niche & academic (5):** GreenJobsBoard, EuroJobs, OpenSourceDesignJobs, AcademicCareers, RemoteFirstJobs
**Phase 22 — Eastern European, CIS & Singapore (4):** Djinni (Ukraine), HeadHunter (Russia/CIS), HabrCareer (Russia), MyCareersFuture (Singapore)

Total sources expanded from 126 to 144.

## [0.8.0] — 2026-02-20

### Phases 15–18: European Government & RSS Expansion (19 sources)

**Phase 15 — European government & regional (5):** JobTechDev (Sweden), France Travail, NAV Jobs (Norway), Jobs.ac.uk, Jobindex (Denmark)
**Phase 16 — Global expansion (4):** GetOnBoard (LatAm), Freelancer.com, JoinRise, Canada Job Bank
**Phase 17 — NGO & international (3):** ReliefWeb, UNDP Jobs, DevITJobs
**Phase 18 — Niche RSS (5):** PyJobs, VueJobs, ConservationJobs, Coroflot, BerlinStartupJobs

Total sources expanded from 107 to 126.

### New Environment Variables

| Variable                         | Purpose                               |
| -------------------------------- | ------------------------------------- |
| `JOBTECHDEV_API_KEY`             | Swedish Employment Service API key    |
| `FRANCETRAVAIL_CLIENT_ID/SECRET` | France Travail OAuth2 credentials     |
| `NAVJOBS_TOKEN`                  | Norwegian NAV bearer token (optional) |

## [0.7.0] — 2026-02-19

### Phases 12–14: ATS & API-Key Expansion (13 sources)

**Phase 12 — ATS & niche board (3):** AuthenticJobs, JobScore (ATS), TalentLyft (ATS)
**Phase 13 — RSS niche boards (10):** CryptoJobsList, Jobspresso, HigherEdJobs, FOSSJobs, LaraJobs, PythonJobs, DrupalJobs, RealWorkFromAnywhere, GolangJobs, WordPressJobs
**Phase 14 — API-key sources & ATS (5):** Talroo, InfoJobs, Crelate (ATS), iSmartRecruit (ATS), Recruiterflow (ATS)

Total sources expanded from 89 to 107 (ATS count: 28 → 38).

### New Environment Variables

| Variable                    | Purpose                      |
| --------------------------- | ---------------------------- |
| `AUTHENTICJOBS_API_KEY`     | Authentic Jobs API key       |
| `TALENTLYFT_API_KEY`        | TalentLyft Bearer token      |
| `TALROO_PUBLISHER_ID/PASS`  | Talroo publisher credentials |
| `INFOJOBS_CLIENT_ID/SECRET` | InfoJobs OAuth credentials   |

## [0.6.0] — 2026-02-17

### Phases 9–11: Job Board & Government Expansion (16 sources)

**Phase 9 — Job board expansion (8):** The Muse, Working Nomads, 4 Day Week, StartupJobs, NoDesk, Web3Career, EchoJobs, JobStreet
**Phase 10 — Government boards & ATS (4):** CareerOneStop (US), Arbeitsagentur (Germany), Jobylon (ATS), Homerun (ATS)
**Phase 11 — Niche boards & developer APIs (4):** Hacker News, Landing.jobs, FindWork, JobDataAPI

Total sources expanded from 73 to 89.

### New Environment Variables

| Variable                 | Purpose                       |
| ------------------------ | ----------------------------- |
| `CAREERONESTOP_API_KEY`  | CareerOneStop Bearer token    |
| `ARBEITSAGENTUR_API_KEY` | German Arbeitsagentur API key |
| `FINDWORK_API_KEY`       | FindWork.dev API token        |
| `JOBDATAAPI_API_KEY`     | JobDataAPI key (optional)     |

## [0.5.0] — 2026-02-16

### Phases 6–8: ATS, Company & Board Expansion (22 sources)

**Phase 6 — New company scrapers (5):** Google Careers, Meta, Netflix, Stripe, OpenAI
**Phase 6 — New ATS integrations (3):** BreezyHR, Comeet, Pinpoint
**Phase 7 — Additional job boards (3):** BuiltIn, Snagajob, Dribbble
**Phase 8 — ATS expansion (10):** Manatal, Paylocity, Freshteam, Bullhorn, Trakstar, HiringThing, Loxo, Fountain, Deel, Phenom
**Phase 8 — Company scrapers (3):** IBM, Boeing, Zoom

Total sources expanded from 51 to 73.

### New Environment Variables

| Variable              | Purpose                   |
| --------------------- | ------------------------- |
| `FRESHTEAM_API_KEY`   | Freshteam API key         |
| `BULLHORN_CORP_TOKEN` | Bullhorn corp token       |
| `TRAKSTAR_API_KEY`    | Trakstar Hire API key     |
| `HIRINGTHING_API_KEY` | HiringThing API key       |
| `LOXO_API_TOKEN`      | Loxo API token (optional) |
| `FOUNTAIN_API_KEY`    | Fountain API key          |
| `DEEL_API_TOKEN`      | Deel API token            |

## [0.4.0] — 2026-02-15

### New Sources (5)

Added 5 new job source integrations (Tier 3 — heavy anti-bot / enterprise ATS):

**ATS (3):**

- **Oracle Taleo** — REST API (JSON), `{company}:{careerSection}` slug format
- **iCIMS** _(WIP)_ — JSON gateway + Playwright fallback with stealth mode
- **SAP SuccessFactors** _(WIP)_ — OData API + HTML fallback, `{instance}:{companyId}` slug format

**Job Boards (2):**

- **Monster** _(WIP)_ — `appsapi.monster.io` JSON API + Playwright stealth fallback (DataDome protected)
- **CareerBuilder** _(WIP)_ — Cheerio + Playwright stealth fallback (Cloudflare protected)

Total sources expanded from 46 to 51.

### New `siteType` Values

- `taleo`, `icims`, `successfactors` — ATS sources (require `companySlug` parameter)
- `monster`, `careerbuilder` — search-based job boards (included in default searches)

### BrowserPool Stealth Mode

New `stealth: true` option for `BrowserPool.getPage()` enables anti-bot evasion:

- User-Agent rotation (6 recent Chrome UAs across Mac/Win/Linux)
- Viewport randomization (5 common resolutions)
- JavaScript injection to mask `navigator.webdriver`, fake `window.chrome.runtime`, override `navigator.plugins`, patch canvas fingerprinting, and spoof WebGL renderer info

### Proxy Support

All 5 sources wire proxies through:

- HTTP sources: via `createHttpClient({ proxies })`
- Playwright sources: via `BrowserPool.getPage({ proxy, stealth: true })`

### WIP Sources Note

4 of 5 sources are marked WIP — Monster and CareerBuilder will likely need residential proxies for reliable operation. iCIMS layouts vary per company deployment. SuccessFactors OData access varies per company configuration.

## [0.3.0] — 2026-02-15

### New Sources (7)

Added 7 new job source integrations (Tier 2 — HTML scraping / Playwright):

**ATS (3):**

- **BambooHR** — Public JSON API, `{companySlug}.bamboohr.com/careers/list`
- **Personio** — Public XML feed, `{companySlug}.jobs.personio.de/xml`
- **JazzHR** _(WIP)_ — HTML scraping, `{companySlug}.applytojob.com/apply/jobs/`

**Job Boards (4):**

- **Dice** _(WIP)_ — Cheerio + Playwright fallback, US tech jobs
- **SimplyHired** _(WIP)_ — Cheerio + Playwright fallback, global
- **Wellfound** _(WIP)_ — Playwright SPA (`__NEXT_DATA__` extraction), startup jobs
- **StepStone** _(WIP)_ — Playwright SPA, Germany (`.de`) initially

Total sources expanded from 39 to 46.

### New `siteType` Values

- `bamboohr`, `personio`, `jazzhr` — ATS sources (require `companySlug` parameter)
- `dice`, `simplyhired`, `wellfound`, `stepstone` — search-based job boards (included in default searches)

### Proxy Support

All 7 sources wire proxies through:

- HTTP sources: via `createHttpClient({ proxies })`
- Playwright sources: via `BrowserPool.getPage({ proxy })`

### WIP Sources Note

5 of 7 sources are marked WIP — code is shipped but HTML selectors need validation against live sites. These sources will gracefully return empty results if selectors are outdated.

## [0.2.0] — 2026-02-14

### New Sources (5)

Added 5 new job source integrations (Tier 1.5 — free API key required):

- **USAJobs** — US government job board (`USAJOBS_API_KEY` + `USAJOBS_EMAIL`)
- **Adzuna** — Multi-country aggregator, 12+ countries (`ADZUNA_APP_ID` + `ADZUNA_APP_KEY`)
- **Reed** — UK-focused job board (`REED_API_KEY`)
- **Jooble** — 70+ country aggregator (`JOOBLE_API_KEY`)
- **CareerJet** — 80+ country aggregator (`CAREERJET_AFFID`)

Total sources expanded from 34 to 39.

### New `siteType` Values

- `usajobs`, `adzuna`, `reed`, `jooble`, `careerjet` — search-based job sources (included in default searches when API keys are configured)

### New Input Field

- `clientIp` — Optional client IP address for sources that require it (e.g. CareerJet). Also useful for residential proxy rotation strategies. Combined with the existing `proxies` array for multi-IP support.

### Per-Request Auth Override

All API-key sources now support per-request credential override via `auth` in the request body, following the existing Upwork pattern. This allows clients to use their own API keys instead of (or in addition to) server-side environment variables.

New `auth` sub-objects: `auth.usajobs`, `auth.adzuna`, `auth.reed`, `auth.jooble`, `auth.careerjet`, `auth.exa`

Each credential field resolves independently — callers can override individual fields while keeping others from env vars (e.g. override `auth.usajobs.apiKey` but keep `email` from `USAJOBS_EMAIL`).

## [0.1.1] — 2026-02-14

### New Sources (8)

Added 8 new job source integrations (Tier 1 — public APIs/RSS, no auth required):

- **Job Boards (6):** RemoteOK, Remotive, Jobicy, Himalayas, Arbeitnow, We Work Remotely
- **ATS (2):** Recruitee, Teamtailor

Total sources expanded from 26 to 34.

### New `siteType` Values

- `remoteok`, `remotive`, `jobicy`, `himalayas`, `arbeitnow`, `weworkremotely` — search-based job boards (included in default searches)
- `recruitee`, `teamtailor` — ATS sources (require `companySlug` parameter)

## [0.1.0] — 2026-02-08

### New Endpoints

- `POST /api/jobs/search` — search for jobs across multiple boards
  - JSON body input with `ScraperInputDto`
  - Wrapped response: `{ count, jobs, cached }`
  - CSV export via `?format=csv`
  - Pagination via `?paginate=true&page=1&page_size=10`
  - Response caching with configurable TTL
- `POST /api/jobs/analyze` — search and analyze jobs with summary statistics
- `GET /health` — service health with uptime, version, and memory usage
- `GET /ping` — simple liveness check

### Security

- API key authentication via configurable header (default: `x-api-key`)
- Per-client request throttling with configurable limits

### Response Headers

- `X-Request-Id` — unique request identifier for tracing
- `X-Process-Time` — request processing duration in ms
