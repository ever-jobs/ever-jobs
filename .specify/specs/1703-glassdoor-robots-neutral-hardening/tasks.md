# Tasks: 1703 — Glassdoor: fail fast, say why, and stop paginating forever

> Status legend: `[ ]` pending • `[~]` in-progress • `[x]` done • `[-]` dropped

- [x] T01 — Constants: page size/cap, Remote pseudo-location id, per-request header maps picked from `GLASSDOOR_HEADERS`, fallback currencies, `readGlassdoorOptions()` for `EVER_JOBS_GLASSDOOR_LEGACY` / `EVER_JOBS_GLASSDOOR_MAX_PAGES`. Acceptance: every existing export unchanged; option parsing covered (all/list/unknown/off; cap override, clamp, junk).
- [x] T02 — A1: `isChallengePage` + fail fast on the homepage (thrown and 200). Acceptance: `blocked`, `homepage challenge (HTTP 403, cf-mitigated: challenge)`, `post` never called; legacy `challenge` still posts; a non-challenge failure still continues with the fallback token.
- [x] T03 — A8: `extractCsrfToken`. Acceptance: `null` on the challenge fixture (beacon-token regression); the colon token from `home-with-token.html`; beacon-only page `null`; `gdCSRF = "x"` → `x`; `(no csrf token extracted)` appended to later diagnostics only when no token was found.
- [x] T04 — A2: `readGraphBody` + diagnostics. Acceptance: errors-only → `fetch_error` containing `FilterParamInput`; batched errors-with-data → rows, no diagnostics; `{}` → `unknown` / `graphql: empty body`; HTML → `graphql: non-JSON body`; a challenge body → `blocked`; earlier rows kept.
- [x] T05 — A3: bounded pagination. Acceptance: page-1-only cursor with `resultsWanted: 100` → 1 post; repeated ids → 2 posts; budget `ceil((offset + rw)/30) + 1`; cap 30 pages / 900 rows; env cap; `offset`; merged cursors; no sleep after the last request.
- [x] T06 — A4: ids and URLs. Acceptance: shared `adOrderId` rows both kept as `gd-<listingId>`; canonical `job-listing/j?jl=` URL; `companyUrl`; no `//` on regional domains; legacy `ids` and `job-url`.
- [x] T07 — A5: `isRemote`. Acceptance: only the locId 11047 row; every row in a remote search; legacy `remote`.
- [x] T08 — A6: location post-filter. Acceptance: `Austin, TX` → only the Austin row, 1 post; state match; remote rows only in a remote search; `empty` detail when nothing is left; unparseable location → no filter; offset counts kept rows; legacy `location-filter`.
- [x] T09 — A7: per-request headers. Acceptance: UK run → `origin`/`referer` `https://www.glassdoor.co.uk`, search URL `.../graph`, homepage GET without `content-type`; no `authority`, no per-request `user-agent`; client hints dropped with a caller UA; every API value equals a pre-1703 value; legacy `headers` → `setHeaders(GLASSDOOR_HEADERS)`.
- [x] T10 — A9: rating, listing type, locations, currency, title fallback. Acceptance: rating 4.2 / null for 0; `sponsored` from the sponsorship level; `GBP` fallback on the UK domain; legacy `listing-type` and `currency`.
- [x] T11 — Spec 1696 posted time. Acceptance: ageInDays 0 / 5 / null → dates identical to before, `day` / `relative`, no `datePostedAt`; a negative age → `null`.
- [x] T12 — Unsupported country → `bad_input`, no request.
- [x] T13 — E2E rewritten (no silent zero, ≤ 2 requests). Acceptance: live run 2026-09-25 → 1 request, `blocked`.
- [x] T14 — Red control: disabling the fail-fast fails 4 service cases; disabling the three pagination stops fails 5 A3 cases.
- [x] T15 — Tests: utils 66/66, service 46/46; `tsc --project tsconfig.typecheck.json` clean for this plugin.
- [x] T16a — Integrator: `docs/index.md` / `docs/log.md` rows added (2026-09-25).
- [ ] T16b — Owner decision: keep Glassdoor in the default site list or gate it behind a flag (spec §9). Recorded as Q-099 in `docs/questions.md`, open. Default A relies on `EVER_JOBS_CRAWL_ROBOTS_TXT=respect`, which arrives with Spec 1690 (branch `feat/http-politeness`, not merged here): until that branch merges, the switch does nothing.
