# Plan: 1715 — Softy source: stop on push-back, sitemap-first for real

| Field        | Value                              |
| ------------ | ---------------------------------- |
| Spec         | [spec.md](./spec.md)               |
| Created      | 2026-09-26                         |
| Last updated | 2026-09-26                         |

## 1. Approach

Spec 1691 built the right shape — sitemap, then detail pages one at a time — but treated
almost every failure as "try something else". This spec turns the plugin's failure
handling into two explicit tables (spec §7.3 for the sitemap, §7.4 for pages) and makes
each cell a deliberate decision with a switch back to the shipped behaviour.

**Classification first.** `fetchOutcome` today returns `ok` / `missing` / `failed` and
throws for "fatal". It gains the categories the tables need: `blocked` (401/403/407, a
200 page with bot-wall markers), `throttled` (429/503), `unknown-tenant` (`ENOTFOUND` on
the scrape's first request) and keeps `missing` / `failed` / `fatal`. The sitemap stage
wraps `run.client` in a small adapter handed to `fetchSitemap`, so the plugin sees the
status and the raw body of `/sitemap.xml` (to tell a bot wall from a soft-404, spec D1)
while pacing, identity and retries stay in `HttpClient`. The adapter refuses to send
anything once the scrape has stopped, so a stop inside a nested sitemap costs nothing.

**One stop flag, one diagnostic.** A scrape stops by setting `run.stopped` with a
`stopReason` (`blocked` / `rate_limited`); every request path checks it. `run.error` is
kept with `preferRefusalError` (Spec 1714), so a 429 after a 502 is what the API sees,
and the response diagnostic is built from `stopReason` first. This is what lets the
multi-location loop and the circuit breaker (Spec 1714 FR-14/FR-15) finally see Softy's
push-back.

**Selection fixes are local.** The `auto` decision in `collect()` compares the budget
with `wanted` (G19), respects an operator-level `sitemap` over `board` by reading
`provenance.discovery` (G22), and never picks the listing when `SOFTY_MAX_LIST_PAGES=0`.
Discovery is resolved inside the plugin's own scrape context, so the Spec 1714 lock
governs the caller's `crawl.discovery` on every path.

**Caches** are `BoundedTtlCache`s on the singleton service, like the detail cache: a
per-tenant sitemap cache (entries only, 10 min), a per-tenant unknown-tenant cache (1 h),
and the detail cache with per-entry TTLs (sitemap entries never expire by default,
listing entries 6 h — spec D3).

**Proof** comes from a new integration suite that drives the real `HttpClient` and
limiter against a loopback server through a protected `tenantOrigin` seam, asserting the
exact request sequence and spacing, with two control runs under the legacy switches that
show the old sequence and the old spacing. The live e2e moves to a weekly schedule.

## 2. Phases

### Phase 1 — Config, manifest, selection (SOFTY; needs Spec 1714 T02 for types)

- Goal: new knobs and the corrected `auto` decision.
- Deliverables: T01, T02, T03.
- Exit criteria: config and policy tests green, parity test green with Spec 1714's
  `BUILTIN_SOFTY_HOST_POLICY`.

### Phase 2 — Failure handling and caches (SOFTY)

- Goal: spec §7.3 / §7.4 tables, caches, the fresh-fetch marker.
- Deliverables: T04, T05, T06, T07, T08.
- Exit criteria: every row of both tables covered by a unit test with its red control.

### Phase 3 — Proof and CI (SOFTY)

- Goal: real-client integration proof; CI no longer hits Softy on push/PR.
- Deliverables: T09, T10, T11.
- Exit criteria: integration suite < 30 s, both control runs shown; CI YAML test (if
  extended) green.

### Phase 4 — Docs (SOFTY README; CORE and API lanes per Spec 1714 T18/T19)

- Deliverables: T12 here; the Softy section of `docs/CRAWL_POLICY.md` (Spec 1714 T18,
  CORE lane) and the changelog / questions / index / `.env.example` entries (Spec 1714
  T19, API lane).

### Phase 5 — Integration verification (orchestrator, Spec 1714 T20)

## 3. Lane ownership

Same disjoint split as [Spec 1714 plan §3](../1714-crawl-caller-lock-and-host-policies/plan.md).
For this spec:

| Lane | Files |
|---|---|
| SOFTY | `packages/plugins/source-ats-softy/**` (src, tests, fixtures), `.github/workflows/ci.yml`, `README.md`, `scripts/__tests__/ci-workflow.spec.ts` (only if extended) |
| CORE | the Softy section of `docs/CRAWL_POLICY.md` (written from this spec); the shared pieces this plugin consumes (Spec 1714 T02, T09) |
| API | `docs/API_CHANGELOG.md`, `docs/log.md`, `docs/index.md`, `docs/questions.md`, `.env.example` entries for the `SOFTY_*` variables |
| orchestrator | this folder (ticks, As built) |

## 4. Packages Touched

| Package | Change |
|---|---|
| `packages/plugins/source-ats-softy` | `softy.{constants,config,types,parser,service}.ts`, `index.ts`; tests `softy.{service,policy,parser}.spec.ts`, new `softy.integration.spec.ts`, `softy.e2e-spec.ts`; new fixtures (challenge page, duplicate-id sitemap) |
| `.github/workflows` | `ci.yml`: `workflow_dispatch`, weekly `schedule`, `EVER_JOBS_LIVE_SOFTY` on the source e2e step, a notice when skipped |
| repo root | `README.md` "For website operators" |
| `packages/common`, `packages/models` | consumed only (Spec 1714) |

## 5. Dependencies

| Library | Version | Rationale |
|---|---|---|
| (none new) | — | Node's `http` module serves the loopback integration test; `BoundedTtlCache`, `fetchSitemap`, `decodeSitemapBody`, `looksLikeChallenge`, `preferRefusalError` come from `@ever-jobs/common` / `@ever-jobs/models`. |

## 6. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| A real tenant's sitemap 404s transiently and `empty` mode returns nothing | L | M | `bad_input` diagnostic names `SOFTY_SITEMAP_FALLBACK=missing`; operator can switch |
| An unmarked bot wall on `/sitemap.xml` is read as "unparseable" and falls back | L | L | Listing page 1 is checked for markers too (stop there); `looksLikeChallenge` covers the common walls |
| Stopping after 1 detail failure shortens results on a flaky day | M | L | Partial result + diagnostic; `SOFTY_MAX_CONSECUTIVE_DETAIL_FAILURES=3` restores |
| Integration test timing flakes on a loaded runner | M | M | Assertions on lower bounds only (≥ 975 ms / ≥ 475 ms), never upper bounds; one file, serial |
| DNS `ENOTFOUND` is transient (resolver hiccup) and a real tenant is cached as unknown for 1 h | L | M | Only `ENOTFOUND` (not `EAI_AGAIN`) counts; TTL bounded (≤ 24 h) and `0` disables; `clearCaches()` |
| Weekly scheduled CI adds runner load | L | L | One run a week (Q-123); `vars.EVER_JOBS_LIVE_SOFTY` for ad-hoc runs |

## 7. Rollback Plan

`SOFTY_SITEMAP_FALLBACK=any-error`, `SOFTY_LEGACY=all`,
`SOFTY_MAX_CONSECUTIVE_DETAIL_FAILURES=3`, `SOFTY_DETAIL_ATTEMPT_SLACK=100`,
`SOFTY_UNKNOWN_TENANT_TTL_MS=0`, `SOFTY_SITEMAP_CACHE_TTL_MS=0`,
`SOFTY_DETAIL_CACHE_TTL_MS=21600000` together restore the Spec 1691 plugin behaviour;
the manifest / lock side is undone by operator policy (Spec 1714 §7.4). Code: revert the
SOFTY lane's commits.

## 8. Migration Plan (if applicable)

None. Tenant addressing and every export stay; results for healthy tenants are the same
jobs with fewer requests. Visible changes: push-back now shows as `blocked` /
`rate_limited` instead of an empty board, unknown tenants as `bad_input`, and posts carry
`jobUrlFetchedAt`.

## 9. Open Questions for Plan

Q-120 and Q-123 (spec §9) carry defaults; none blocks implementation.
