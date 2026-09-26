# Tasks: 1708 — Wellfound search reads the server-rendered landing pages

| Field        | Value      |
| ------------ | ---------- |
| Spec ID      | 1708       |
| Status       | done       |
| Last updated | 2026-09-25 |

> Status legend: `[ ]` pending • `[~]` in-progress • `[x]` done • `[-]` dropped

## Phase 1 — Parser and types

- [x] T01 — Verified types and constants
  - **Files:** `src/wellfound.types.ts`, `src/wellfound.constants.ts`
  - **Acceptance:** Apollo cache, connection, `JobListingSearchResult`, `JobListing`, `StartupResult`, remote config (inline or ref); legacy fields kept as an explicit interface; route builders take a page number; `WELLFOUND_DELAY_MIN/MAX` finally used.

- [x] T02 — Payload extraction and cache navigation
  - **Files:** `src/wellfound.parser.ts`
  - **Acceptance:** attribute-order-independent `extractNextData`; broken JSON → null; refs resolve own keys only (`__proto__` → null); connection found whatever the argument order; listings in `startups[i].highlightedJobListings[j]` order, 7 of 7 on the role/location fixture (regression: the old search returned 0); feed fallback through `listing.startup`.

- [x] T03 — Mapping
  - **Files:** `src/wellfound.parser.ts`
  - **Acceptance:** `/jobs/{id}-{slug}`; company from `StartupResult`; `SIZE_51_200` → `51-200`; `liveStartAt 1790107906` → `2026-09-22` with `datePostedAt`; remote kinds and `workFromHomeType`; compensation table incl. `CAD`, equity, hourly, monthly; Markdown unchanged, PLAIN stripped, HTML escape-first with http(s)-only links; no `atsType` from `atsSource`; legacy fields as fallbacks.

- [x] T04 — Routing and local filters
  - **Files:** `src/wellfound.parser.ts`
  - **Acceptance:** routing table; no `q=`, `/search`, `role=`, `jobId=`; no `/role/l/{role}` without a location; `Remote` location → remote route; `c++`/`c#` tokens; all-tokens word-start matching.

- [x] T05 — Parser suite
  - **Files:** `__tests__/wellfound.parser.spec.ts`, `__tests__/fixtures/*`
  - **Acceptance:** 88/88; fixtures synthetic (invented companies, ids and text; real key names and edge cases).

## Phase 2 — Service

- [x] T06 — HTTP-first scrape with the fallback chain
  - **Files:** `src/wellfound.service.ts`
  - **Acceptance:** one GET on the happy path, no browser; honest UA unless the caller sets one; all proxies passed; redirects pinned to `wellfound.com`; 404 / `/_error` / wrong role / no results → next route.

- [x] T07 — Classification and diagnostics
  - **Files:** `src/wellfound.service.ts`
  - **Acceptance:** payload checked before challenge markers (beacon regression); 403 interstitial → `blocked` with no browser escalation; drift → `unknown`; filters → `empty` with counts; page-1 network error classified.

- [x] T08 — Sequential pagination
  - **Files:** `src/wellfound.service.ts`
  - **Acceptance:** one request in flight; `randomSleep(3000, 7000)` between pages; stops at `pageCount`, 10 pages, no new ids, or enough matches; later failure → `partial` with the jobs so far.

- [x] T09 — Operator options
  - **Files:** `src/wellfound.constants.ts`, `src/wellfound.service.ts`
  - **Acceptance:** `WELLFOUND_FETCH_MODE`, `WELLFOUND_ROUTE_MODE`, `WELLFOUND_DESCRIPTION_SOURCE`, `WELLFOUND_JOB_URL_STYLE`; unknown values warn and use the default; browser mode uses one non-stealth page and closes it.

- [x] T10 — Service suite
  - **Files:** `__tests__/wellfound.service.spec.ts`
  - **Acceptance:** 33/33, including two concurrent scrapes on one instance.

## Phase 3 — Live check and docs

- [x] T11 — Gated live e2e
  - **Files:** `__tests__/wellfound.e2e-spec.ts`
  - **Acceptance:** jobs or an explicit `blocked`, never a silent empty; run once live 2026-09-25: 2/2, 3 jobs each for a term search and a term + location search over plain HTTP.

- [x] T12 — Mutation control
  - **Acceptance:** challenge check moved before the payload and beacon exclusion removed → 3 beacon/blocked tests red; restored.

- [x] T13 — Type-check and spec docs
  - **Files:** `.specify/specs/1708-wellfound-landing-page-search/{spec,plan,tasks}.md`
  - **Acceptance:** `tsc --project tsconfig.typecheck.json --noEmit` exit 0.

- [x] T14 — `docs/index.md` / `docs/log.md` rows (integrator)

## Notes

- Follow-ups outside this lane: the shared `looksLikeChallenge` beacon fix, the company-board
  plugin's check order and CAD parsing, a crawl manifest once `IPluginMetadata.crawl` exists, and
  a role-slug catalogue from the sitemap.
