# Plan: 1703 — Glassdoor: fail fast, say why, and stop paginating forever

| Field        | Value      |
| ------------ | ---------- |
| Spec ID      | 1703       |
| Status       | done       |
| Last updated | 2026-09-25 |

## 1. Approach

Everything stays inside `packages/plugins/source-glassdoor`. No core package changes: the
challenge heuristic (`looksLikeChallenge`), the diagnostics type, the location parser and the
Spec 1696 posted-time helpers all exist already.

1. **Constants.** Page size / cap / hard ceiling, the Remote pseudo-location id, per-request header
   maps picked from the existing `GLASSDOOR_HEADERS` (so no value is new), a per-country fallback
   currency, and `readGlassdoorOptions()` for the two env vars. Every existing export is kept.
2. **Utils.** Pure, total helpers: `isChallengePage`, `extractCsrfToken`, `readGraphBody`,
   `isRemoteListing`, `listingIdOf`, URL builders over `new URL()`, `buildHeaders`, the location
   matcher. `parseCompensation` gains an optional fallback currency whose default keeps `USD`.
3. **Service.** Resolve the options once per scrape. Homepage GET with document headers; a
   challenge returns `blocked` before any search. The page loop checks the cursor and the budget
   before each request, reads the body through `readGraphBody`, stops on zero new ids, and sleeps
   only when another request follows. Mapping moves into `toJobPost`, which also returns the row's
   own remote signal for the location filter. Each legacy behaviour is one `legacy.has(...)` branch
   that runs the old expression verbatim.
4. **Tests.** Synthetic fixtures; a utils spec and a mocked-HTTP service spec that count requests;
   the live e2e rewritten to assert "rows or a reason" in at most 2 requests.

## 2. Packages Touched

| Package | Change |
| --- | --- |
| `packages/plugins/source-glassdoor` | constants, utils, service; three specs; synthetic fixtures |
| `packages/common`, `packages/models` | (no change) |

## 3. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| Behaviour change breaks a consumer that stored `gd-<adOrderId>` ids | L | M | `EVER_JOBS_GLASSDOOR_LEGACY=ids` restores them |
| The location post-filter drops rows a caller wanted | M | L | `empty` diagnostic says how many were removed; `EVER_JOBS_GLASSDOOR_LEGACY=location-filter` turns it off |
| Real payloads differ from the synthetic fixtures (the site cannot be reached from our egress) | M | M | every reader is defensive; unknown shapes surface as `unknown` / `fetch_error`, never a silent zero |
| A future site token changes shape | M | L | the fallback token is still sent and the diagnostics say `(no csrf token extracted)` |

## 4. Rollback Plan

`EVER_JOBS_GLASSDOOR_LEGACY=all` restores every pre-1703 behaviour except the unbounded page
loop, without a redeploy of code. A full revert is the plugin directory alone.
