# Tasks: 1715 — Softy source: stop on push-back, sitemap-first for real

> Status legend: `[ ]` pending • `[~]` in-progress • `[x]` done • `[-]` dropped

Spec: [spec.md](./spec.md) · Plan: [plan.md](./plan.md) · Shared layer:
[Spec 1714 tasks](../1714-crawl-caller-lock-and-host-policies/tasks.md)

**Status (2026-09-27, review round 2):** in progress. T01–T14 are done; review round 2
(Phase 6, T16–T22) landed its code, tests and docs — T22 (the `@SourcePlugin` declaration
of the 1 s client floor) in commit d235e9df — and its second pass (T23–T26) too. Left:
**T15** — the orchestrator's joint verification with Spec 1714 T20 (full Softy suite incl.
the skip of the live e2e, typecheck, `test:core`, `lint:docs`, every red control reported,
round 2 included). The spec moves to `done` when it is ticked.

All tasks below are the **SOFTY** lane unless marked otherwise (disjoint ownership,
[Spec 1714 plan §3](../1714-crawl-caller-lock-and-host-policies/plan.md)). Each key test
has a **red control**: the same test run once with the named legacy switch must fail for
the stated reason, then pass with the default; report both runs with the exact command
(`cd /e/Coding/Worktrees/ever-jobs-softy-audit-fixes && npx jest --testPathPatterns
packages/plugins/source-ats-softy …`). Depends on Spec 1714 T02 (types, `BUILTIN_SOFTY_HOST_POLICY`,
`preferRefusalError`, `jobUrlFetchedAt`) and T09 (`fetchSitemap` `nestedErrors` default).

## Phase 1 — Config, manifest, selection

- [x] T01 — Configuration and constants
  - **Files:** `src/softy.constants.ts`, `src/softy.config.ts`, `src/softy.types.ts`,
    `src/index.ts`, a config test in `__tests__/softy.service.spec.ts` (or a new
    `__tests__/softy.config.spec.ts`)
  - **Gaps:** contract for G3, G6, G13, G19–G25, K0, K1
  - **Acceptance:** spec §7.1 constants and types; `readSoftyConfig` reads
    `SOFTY_SITEMAP_FALLBACK` (enum, case-insensitive), `SOFTY_UNKNOWN_TENANT_TTL_MS`
    (0..86,400,000, above clamped with a one-time warning), `SOFTY_DETAIL_ATTEMPT_SLACK`,
    `SOFTY_SITEMAP_CACHE_TTL_MS`, `SOFTY_LEGACY` (comma list, `all`, unknown tokens warned
    once), `SOFTY_MAX_LIST_PAGES` minimum 0, `SOFTY_MAX_CONSECUTIVE_DETAIL_FAILURES`
    default 1; derives `listingDetailCacheTtlMs` and `minIntervalFloorMs` (spec FR-13,
    FR-2). Every constant whose default changed has a comment naming the switch and the
    value that restores the pre-1715 behaviour. The config table in the `readSoftyConfig`
    doc comment lists every variable.
  - **Tests:** defaults; each variable valid / invalid / clamp; `SOFTY_LEGACY=all` and a
    mixed list with an unknown token.
  - **Estimate:** 0.5 day

- [x] T02 — Manifest, client floor, lock and parity
  - **Files:** `src/softy.constants.ts` (`SOFTY_CRAWL_POLICY`), `src/softy.service.ts`
    (`createHttpClient({ …, minIntervalFloorMs: config.minIntervalFloorMs })`),
    `__tests__/softy.policy.spec.ts`
  - **Gaps:** G0, G3, G14 (with Spec 1714)
  - **Acceptance:** manifest exactly spec FR-1; floor 1000 unless
    `SOFTY_LEGACY=no-interval-floor`; the resolved policy for `softy` + `acme.softy.pro`
    equals the FR-1 numbers.
  - **Tests:** parity (every `BUILTIN_SOFTY_HOST_POLICY` field equals the manifest's; the
    manifest adds only `userAgentMode`) — **red control:** set the manifest's `minGapMs` to
    400 → red. Lock through the real resolver: caller `crawl: { discovery: 'listing' }`
    refused (sitemap requested first), `sitemap` accepted, inside and outside a scrape
    context — **red control:** operator `sites.softy.callerOverrides: 'any'` → the listing
    is requested first. The two existing tests that expected the caller's `listing` to win
    are rewritten accordingly.
  - **Estimate:** 0.5 day

- [x] T03 — Discovery resolution and the `auto` decision
  - **Files:** `src/softy.service.ts` (`scrape`, `resolveDiscovery`, `collect`,
    `collectFromListing`), `__tests__/softy.service.spec.ts`
  - **Gaps:** G19, G22
  - **Acceptance:** outside `JobsService` the plugin opens its scrape context **before**
    resolving discovery (no early return of the raw caller value); discovery and its
    provenance come from `getEffectiveCrawlPolicy(host)`; `auto` compares the detail budget
    with `wanted` (`offset-budget` → `offset + wanted`); an operator-level `sitemap`
    (provenance `env-global` / `operator-site` / `operator-host`) beats `board`
    (`board-over-sitemap` → pre-1715) and adds the `partial` note; with
    `maxListPages === 0`, `auto` never picks the listing and an explicit `listing`
    returns `[]` + a `bad_input` note without a request.
  - **Tests:** offset 20 + 10 wanted, budget 25 → sitemap first (**red control:**
    `SOFTY_LEGACY=offset-budget` → `PAGE(1)` first); `EVER_JOBS_CRAWL_DISCOVERY=sitemap` +
    board → `[SITEMAP]` + `partial` (**red control:** `SOFTY_LEGACY=board-over-sitemap` →
    `[PAGE(1)]`); `SOFTY_MAX_LIST_PAGES=0` cases.
  - **Estimate:** 0.5 day

## Phase 2 — Failure handling and caches

- [x] T04 — Sitemap stage: adapter, body kinds, fallback table, unknown tenant, sitemap cache, dedupe
  - **Files:** `src/softy.service.ts` (`discoverFromSitemap` → a discriminated outcome,
    a `fetchSitemap` adapter over `run.client`, `collectFromSitemap`), `src/softy.parser.ts`
    (`softySitemapBodyKind`), `__tests__/softy.service.spec.ts`, `__tests__/softy.parser.spec.ts`,
    new fixtures `__tests__/fixtures/{challenge.html,sitemap-duplicate-ids.xml}`
  - **Gaps:** G13, G16, G21, G23, G25, K0, K1
  - **Acceptance:** spec §7.3 exactly, per `SOFTY_SITEMAP_FALLBACK`; the adapter decodes
    the body with `decodeSitemapBody`, classifies it with `softySitemapBodyKind`, throws a
    blocked error for a challenge, and sends nothing once the scrape stopped; a nested
    stop from `fetchSitemap` (429/503/crawl-policy) is a scrape stop with `rate_limited`;
    the unknown-tenant check happens before any request (cache) and on the first request's
    `ENOTFOUND` (error or `cause`); the sitemap cache stores the filtered, sorted,
    deduplicated entries of a sitemap with ≥ 1 offer; dedupe by offer id keeps the newest
    `lastmod`, then `offset` applies (`duplicate-ids` → pre-1715).
  - **Tests:** one test per §7.3 row under `empty`, the `missing` 404 row, the whole
    `any-error` column in one parameterised test (= the old "falls back on …" test).
    **Red controls:** 503 / `ECONNRESET` / 403 / bot-wall rows with
    `SOFTY_SITEMAP_FALLBACK=any-error` → the listing is requested; 404 row with `missing`
    → listing; unknown tenant with `SOFTY_UNKNOWN_TENANT_TTL_MS=0` → the second scrape
    asks DNS again; repeat scrape with `SOFTY_SITEMAP_CACHE_TTL_MS=0` → the sitemap is
    requested again; duplicate ids with `SOFTY_LEGACY=duplicate-ids` → two GETs.
  - **Estimate:** 1 day

- [x] T05 — Page stage: push-back, attempt cap, error precedence, legacy index path
  - **Files:** `src/softy.service.ts` (`fetchOutcome`, `getDetail`, `collectFromListing`,
    `collectLegacyIndex`, `emitCards`, `isFatal`, `stopOnFatal`, `scrapeTenant`
    diagnostic), `__tests__/softy.service.spec.ts`
  - **Gaps:** G6, G13, G17, G20, K1
  - **Acceptance:** spec §7.4 exactly; `run.stopped` + `stopReason` block every later
    request; `run.error = preferRefusalError(run.error, err)` everywhere an error is
    recorded; diagnostics per spec §7.5; detail GETs capped at `min(budget, wanted +
    slack)` with a `partial` note; the legacy index at `SOFTY_LEGACY_INDEX_PATH`
    (`/offers`; `offres` → `/offres`).
  - **Tests:** detail 403 → `[SITEMAP, OFFER(1005)]`, `blocked` (**red control:**
    `SOFTY_LEGACY=block-as-missing` → the next detail is requested); challenge detail page
    → `blocked`; listing page 1 challenge → `blocked`, no legacy index; detail 503 →
    `rate_limited` (**red control:** `503-as-failure` → `fetch_error`, the walk goes on
    until the failure limit); detail 502 then the next not requested (**red control:**
    `SOFTY_MAX_CONSECUTIVE_DETAIL_FAILURES=3` → 3 requested); 502 then 429 → `rate_limited`;
    listing page 2 500 → page 1 cards board-only, no detail request (**red control:**
    `listing-failure-details` → details requested); a generated 10-offer sitemap whose details all answer 404, wanted 2 → 7 detail
    GETs + `partial` (**red control:** `SOFTY_DETAIL_ATTEMPT_SLACK=100` → every entry
    requested); legacy index request path (**red control:** `offres`).
  - **Estimate:** 1 day

- [x] T06 — Detail cache TTL semantics and `clearCaches()`
  - **Files:** `src/softy.service.ts` (`getDetailCache`, `getDetail`, `clearCaches`),
    `__tests__/softy.service.spec.ts`
  - **Gaps:** G24 (part)
  - **Acceptance:** spec FR-13: env unset → sitemap entries `set(key, v, 0)` (no expiry),
    listing entries `set(key, v, SOFTY_LISTING_DETAIL_CACHE_TTL_MS)`; env set → every entry
    that TTL (0 = no expiry); the cache shape key includes the effective TTLs;
    `clearCaches()` empties the detail, sitemap and unknown-tenant caches.
  - **Tests (fake clock):** env unset: a sitemap entry survives 7 h, a listing entry
    expires after 6 h; `SOFTY_DETAIL_CACHE_TTL_MS=21600000` → the sitemap entry expires
    after 6 h (**red control** for the new default).
  - **Estimate:** 0.25 day

- [x] T07 — `jobUrlFetchedAt` on freshly fetched posts
  - **Files:** `src/softy.service.ts` (`getDetail` returns the fetch time for a network
    fetch, `buildPost` / `processJob`), `__tests__/softy.service.spec.ts`
  - **Gaps:** G4, G28 (with Spec 1714 T16)
  - **Acceptance:** set only when the detail came from the network in this scrape, was
    2xx and parsed, and the fetched URL equals the post's `jobUrl` (sitemap and listing
    paths, legacy cards included); absent for cache hits and board-only posts.
  - **Tests:** first scrape → every post has an ISO `jobUrlFetchedAt`; a repeat scrape
    (cache hits) → none. **Red control:** mutate `processJob` to omit the field → red.
  - **Estimate:** 0.25 day

- [x] T08 — Migrate the tests that enshrined the audited behaviour
  - **Files:** `__tests__/softy.service.spec.ts`, `__tests__/softy.policy.spec.ts`
  - **Gaps:** G26
  - **Acceptance:** every row of spec §8.1's migration table: the default assertion is
    new, the old assertion is kept under its switch (none deleted); the suite stays
    offline; the "≤ 1 request in flight" fake-client checks still pass.
  - **Estimate:** 0.5 day

## Phase 3 — Proof and CI

- [x] T09 — Integration test: real `HttpClient` and limiter against a loopback server
  - **Files:** new `__tests__/softy.integration.spec.ts`; `src/softy.service.ts`
    (`protected tenantOrigin(tenant)`, every URL built from `run.origin` via the
    `…From(origin, …)` parser helpers; `run.host` = the origin's host)
  - **Gaps:** G26 (and end-to-end proof of G3, G7, G13, G14, G20, G21, K1)
  - **Acceptance:** spec §8.2 scenarios S1–S7 and controls C1–C2; `EVER_JOBS_CRAWL_EGRESS_ALLOW_HOSTS=127.0.0.1`
    set and restored; `resetHostLimiter()`, `resetCrawlPolicyEnvCache()`,
    `resetEffectiveCrawlPolicyCache()` and `service.clearCaches()` per test; the server
    binds `127.0.0.1:0` and is closed in `afterAll`; lower-bound timing assertions only;
    the file runs under 30 s. C1 and C2 are green assertions of the OLD sequence / spacing
    under the legacy switches; the report also shows S3 and S1 run once with those
    switches and failing (the red controls).
  - **Estimate:** 1 day

- [x] T10 — Live e2e gated, sitemap-first asserted
  - **Files:** `__tests__/softy.e2e-spec.ts`
  - **Gaps:** G26, G30
  - **Acceptance:** `EVER_JOBS_LIVE_SOFTY === '1'` runs the two live tests; otherwise they
    are skipped under a describe title such as "live Softy e2e — skipped: set
    EVER_JOBS_LIVE_SOFTY=1 (CI: schedule / workflow_dispatch)"; the offline test still
    runs; when live, a spy on `HttpClient.prototype.request` shows the first URL ends in
    `/sitemap.xml`. Not run by the lane (no live traffic); the skip is shown with
    `npx jest --testPathPatterns softy.e2e-spec` (0 requests).
  - **Estimate:** 0.25 day

- [x] T11 — CI: the live Softy e2e only on schedule / dispatch
  - **Files:** `.github/workflows/ci.yml`, optionally `scripts/__tests__/ci-workflow.spec.ts`
  - **Gaps:** G30
  - **Acceptance:** `on:` gains `workflow_dispatch:` and `schedule: - cron: '23 4 * * 1'`
    (Q-123); the "Run source scraper e2e tests" step gets
    `EVER_JOBS_LIVE_SOFTY: ${{ (github.event_name == 'schedule' || github.event_name == 'workflow_dispatch') && '1' || vars.EVER_JOBS_LIVE_SOFTY || '0' }}`;
    a preceding step writes a `::notice` naming the skip reason when it is not `1`; nothing
    else in the workflow changes (push/PR jobs identical). If the CI workflow spec is
    extended, it asserts the env line.
  - **Estimate:** 0.25 day

## Phase 4 — Docs

- [x] T12 — README "For website operators"
  - **Files:** `README.md`
  - **Gaps:** G1 (part)
  - **Acceptance:** spec FR-20 content, near the top-level table of contents (reachable
    from the UA link); links to `docs/CRAWL_POLICY.md`; no competitor named; states that
    installs are self-hosted and our own production does not scrape Softy.
  - **Estimate:** 0.25 day

- [x] T13 — [CORE] Softy section of `docs/CRAWL_POLICY.md` — done in Spec 1714 T18
  (§21, checked against the landed code in the docs pass: fallback table, page-stage table,
  budget / dedupe / caches, every `SOFTY_*` variable and `SOFTY_LEGACY` token; the pass
  added the nested-sitemap rows and the cached unknown-tenant diagnostic)
- [x] T14 — [API] `SOFTY_*` rows in `.env.example`, changelog, log, index, Q-120/Q-123 — done in Spec 1714 T19
  (the docs pass added the Softy / CORE / docs log entry, Q-128 on the Softy numbers and the
  CI note in Q-123)

## Phase 5 — Verification (orchestrator)

- [ ] T15 — Verify with Spec 1714 T20
  - **Acceptance:** `npx jest --testPathPatterns packages/plugins/source-ats-softy
    --testPathIgnorePatterns e2e-spec` green; the skip of the live e2e shown; typecheck,
    `test:core`, `lint:docs` green; every red control above reported (Phase 6 included).

## Phase 6 — Review round 2 (2026-09-27)

The plugin halves of the confirmed review findings (the shared-layer halves are
[Spec 1714](../1714-crawl-caller-lock-and-host-policies/tasks.md) T21–T32). SOFTY lane
unless marked; every file under `packages/plugins/source-ats-softy/`; each fix has a test
and a red control the lane ran red, then green.

- [x] T16 — A caller's short detail budget stays on the sitemap under the lock (FR-21, finding A1)
  - **Files:** `src/softy.service.ts` (`resolveCallerLock`, `SoftyRun.callerLock` /
    `budgetKeptOnSitemap`, the `keepSitemap` selection, the `partial` note),
    `src/softy.constants.ts` / `src/softy.config.ts` (`caller-listing`; the path table
    on `readSoftyConfig`), `__tests__/softy.service.spec.ts`, `__tests__/softy.policy.spec.ts`
  - **Acceptance:** `detail-25` + `resultsWanted: 60` under the lock → `[SITEMAP]` + 25
    detail pages, 25 posts, `partial` naming the mode, its layer and the switches; the
    same above `SOFTY_MAX_DETAIL_FETCHES`; inside a scrape context, with the builtin host
    entry alone, and under a global `none`; an operator `auto`, `sites.softy.callerOverrides:
    "any"`, no lock layer, or `SOFTY_MAX_DETAIL_FETCHES=0` read the listing;
    `descriptionDepth: 'board'` unchanged (D5).
  - **Red control:** `SOFTY_LEGACY=caller-listing` → the listing is read again.

- [x] T17 — Nested sitemaps: a struggling child stops, the pre-1715 skip is a switch (FR-22, findings A5, F4)
  - **Files:** `src/softy.service.ts` (`onNestedSitemapError`, `skipsNestedErrors`,
    `nestedErrors` passed to `fetchSitemap`), `src/softy.constants.ts` (`nested-skip`; the
    `any-error` wording), `__tests__/softy.service.spec.ts`, `__tests__/softy.integration.spec.ts`
  - **Acceptance:** a child answering 500/502/504, timing out or resetting → stop,
    `fetch_error` / `timeout`, nothing after it; a 410 child still skipped; under
    `nested-skip` or `any-error` every nested failure skipped (429/503, 403, 5xx).
  - **Red control:** `SOFTY_LEGACY=nested-skip` → the 502 child skipped, the next child and
    its offer fetched (integration C5).

- [x] T18 — Legacy detail URLs at the redirect target (FR-23, finding A0 — plugin half)
  - **Files:** `src/softy.service.ts` (`parseIndex`, `normaliseJob`, `buildJobUrl`),
    `src/softy.constants.ts` (`legacy-detail-url`), `__tests__/softy.service.spec.ts`
  - **Acceptance:** legacy cards link `/offers/{ID}`; detail GETs go there.
  - **Red control:** `SOFTY_LEGACY=legacy-detail-url` → `/offre/{ID}-{slug}` again.

- [x] T19 — `jobUrlListedAt` on sitemap posts (FR-24, finding A3 — plugin half)
  - **Files:** `src/softy.service.ts` (`SitemapStage.listedAt`, `CachedSitemap.listedAt`,
    `collectFromSitemap`, `buildPost`, `processJob`), `__tests__/softy.service.spec.ts`,
    `__tests__/softy.integration.spec.ts`
  - **Acceptance:** every sitemap post carries the root sitemap's network answer time, also
    on a sitemap-cache hit; a new time with the cache off; none on list-page posts (until
    the second pass: T23 sets it there too).
  - **Control:** `SOFTY_SITEMAP_CACHE_TTL_MS=0` → each scrape carries its own time (the
    cache-hit assertion tells the two apart); the API's own switch is Spec 1714 T28.

- [x] T20 — Timing proof of the 1 s interval (FR-25, finding C1 — plugin half)
  - **Files:** `__tests__/softy.integration.spec.ts` (S8, S9, S10, C3, C4, C5)
  - **Acceptance:** spec §8.2 rows S8–S10 and controls C3–C5; lower-bound timing only.
  - **Red control:** C3 (only the interval lowered) → the smallest start gap < 975 ms.

- [x] T21 — [DOCS] Round-2 docs (with Spec 1714 T32)
  - **Files:** `docs/CRAWL_POLICY.md` §14, §16, §21 (paths table, nested sitemaps, the
    `any-error` wording, legacy detail URLs, `jobUrlListedAt`, the three tokens, the
    pre-1715 crawl-policy recipe), `README.md`, `.env.example`, `docs/API_CHANGELOG.md`,
    this spec and tasks
  - **Acceptance:** `npm run lint:docs` clean; no competitor named.

- [x] T22 — Declare the Softy client floor in the plugin metadata (finding F5 / F1 core; done in d235e9df)
  - **Found by:** the round-2 docs pass. Spec 1714 T29 added
    `IPluginMetadata.clientMinIntervalFloorMs` and `meta.clientMinIntervalFloorMs`, but
    `@SourcePlugin({ … })` in `src/softy.service.ts` does not set it, so the policy
    endpoint reports `null` for Softy (its Swagger text says "e.g. Softy: 1000").
  - **Files:** `src/softy.service.ts` (the decorator), a test next to the controller's
    (`apps/api/src/jobs/__tests__/sources-crawl-policy.controller.spec.ts` with the real
    Softy metadata) or in `__tests__/softy.config.spec.ts`
  - **Acceptance:** `GET /api/sources/softy/crawl-policy` shows `1000`; decide whether
    `SOFTY_LEGACY=no-interval-floor` should make it `null` (the decorator is evaluated
    once, at load).
  - **Red control:** without the declaration → `null`.
  - **Done** (d235e9df): `clientMinIntervalFloorMs: SOFTY_MIN_INTERVAL_FLOOR_MS` in the
    decorator; the "null under `no-interval-floor`" question is answered by T26.

## Phase 7 — Review round 2, second pass (2026-09-27)

- [x] T23 — `jobUrlListedAt` on list-page posts (FR-26)
  - **Files:** `src/softy.service.ts` (`collectFromListing`, `addLegacyCards`,
    `emitCards`), `src/softy.types.ts` (`SoftyCardJob.listedAt`), `src/softy.constants.ts`,
    `__tests__/softy.service.spec.ts`, `apps/api/src/jobs/__tests__/jobs.controller.liveness-softy-board.spec.ts`
  - **Acceptance:** board and detail listing posts and legacy-index cards carry their
    page's answer time; end to end (real plugin + `HttpClient` on loopback, real
    controller) `descriptionDepth: 'board'` + `?liveness=true` sends one list page and no
    probe, JSON and NDJSON, and a search-cache repeat none either.
  - **Red control:** `SOFTY_LEGACY=listing-no-listed-at` → every card probed; with the
    card's `listedAt` no longer passed to `buildPost` (the fix hunk reverted, then
    restored byte for byte) 7 tests fail — the 3 plugin listing tests and the 4
    controller tests that expect a trusted board.

- [x] T24 — Remember a tenant with no open offer (FR-27)
  - **Files:** `src/softy.service.ts` (`emptyTenants`, `isKnownEmptyTenant`,
    `cacheEmptyTenant`, `collect`), `__tests__/softy.service.spec.ts`
  - **Acceptance:** sitemap without offers + empty listing → the second search sends 0
    requests (auto and explicit sitemap); asked again at the TTL, after `clearCaches()`,
    after a failed listing page, and when the listing had cards.
  - **Red control:** `SOFTY_LEGACY=empty-board-uncached` (and `SOFTY_SITEMAP_CACHE_TTL_MS=0`)
    → `/sitemap.xml` + `/offers?page=1` again; with the `cacheEmptyTenant` call removed 3
    tests fail (the repeat, the explicit-sitemap repeat, the TTL case).

- [x] T25 — `SOFTY_LEGACY=first-error` (FR-28)
  - **Files:** `src/softy.service.ts` (`keepError`, `stopOnFatal`), `__tests__/softy.service.spec.ts`
  - **Acceptance:** under the token a 502 then a 429 → `fetch_error` naming the 502 (the
    429 still stops); a 502 then a robots.txt refusal → `fetch_error` 502; a sitemap 429
    → `fetch_error`; a crawl-policy cool-down → `rate_limited` (classified); part of `all`.
  - **Red control:** the default twins (`rate_limited`, `blocked`); with the token's branch
    removed from `keepError` and `stopOnFatal` the 4 token tests fail.

- [x] T26 — The effective client floor in the metadata (FR-29, with Spec 1714 T36)
  - **Files:** `src/softy.service.ts` (the decorator), `packages/plugin` metadata interface
  - **Acceptance / red control:** see Spec 1714 T36.

## Gap coverage

| Gap | Task(s) | Note |
|---|---|---|
| G1 | T12 | prod contact / `From` is Q-124 |
| G3 | T02 | floor + manifest (lock in Spec 1714) |
| G6 | T05 | `/offers` |
| G13 | T04, T05 | 503 stop, no fallback, listing failure stops details |
| G14 | T02 | manifest retries / statuses / cool-down |
| G16 | T04 | nested stop (default of Spec 1714 T09) |
| G17 | T05 | `preferRefusalError`, `rate_limited` stop reason |
| G19 | T03 | |
| G20 | T05 | stop on 401/403/407, attempt cap |
| G21 | T04 | fallback table |
| G22 | T02, T03 | lock on discovery + operator sitemap + list pages 0 |
| G23 | T04 | sitemap TTL cache |
| G24 | T06 | per-pod part is Spec 1714 Q-122 |
| G25 | T04 | |
| G26 | T08, T09, T10 | |
| G30 | T10, T11 | |
| K0 | T04 | unknown tenant + negative cache |
| K1 | T04, T05 | blocked stop + diagnostic |

Review round 2 (2026-09-27):

| Finding | Task(s) | Note |
|---|---|---|
| A0 | T18 (+ Spec 1714 T21) | legacy detail URLs; redirect pacing in the shared layer |
| A1 | T16 | `board` kept on the listing (D5) |
| A3 | T19 (+ Spec 1714 T28) | |
| A5, F4 | T17 | |
| C1 | T20 (+ Spec 1714 T30) | |
| F5 | T21, T22, T26 | recipe in the docs; floor declared (d235e9df) and reported as in force (T26) |
| second pass: board + liveness probes every card | T23 | |
| second pass: empty tenant asked every search | T24 | |
| second pass: no switch for the pre-1715 diagnostics | T25 | |

## Notes

- Tests never touch the network; the live e2e is not run by the lane.
- Files LF, no BOM; no commit / push / stash / reset / checkout by the lane.
- Never name any competitor project.
