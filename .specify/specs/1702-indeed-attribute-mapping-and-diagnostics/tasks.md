# Tasks: 1702 — Indeed: remote, job type and location from the right fields, and no silent empty results

> Status legend: `[ ]` pending • `[~]` in-progress • `[x]` done • `[-]` dropped

## Phase 1 — Mapping

- [x] T01 — Attribute codes and switches
  - **Files:** `packages/plugins/source-indeed/src/indeed.constants.ts`
  - **Acceptance:** `INDEED_REMOTE_ATTRIBUTE_KEY`, `INDEED_JOB_TYPE_ATTRIBUTE_KEYS`, legacy key and prefix; `EVER_JOBS_INDEED_ATTRIBUTE_MAPPING`, `EVER_JOBS_INDEED_FORMATTED_LOCATION`, `EVER_JOBS_INDEED_MAX_PAGES` with readers (unset = on / 10; off values restore pre-1702). `INDEED_HEADERS` and `JOB_SEARCH_QUERY` unchanged.

- [x] T02 — Workplace detection
  - **Files:** `packages/plugins/source-indeed/src/indeed.utils.ts`
  - **Acceptance:** `DSQF7`, whole remote labels and a `Remote…` location head give `isRemote: true` / `'Remote'`; hybrid labels or a `Hybrid…` head give `'Hybrid'`; skill labels, the description and the title never count; remote wins; `remotejob` still counts; `{ attributeMapping: false }` is the HEAD rule. `isJobRemote` kept as a wrapper.

- [x] T03 — Job types from codes and whole labels
  - **Files:** `packages/plugins/source-indeed/src/indeed.utils.ts`
  - **Acceptance:** `CF3CP`/`75GKK`/`NJXCK`/`VDTG7` map; "Temporary"/"Permanent" labels map; "Contract management" and "401(k)" do not; de-duplicated; `job-types*` still resolves; legacy option is the HEAD rule.

- [x] T04 — Location from structured fields plus the formatted label
  - **Files:** `packages/plugins/source-indeed/src/indeed.utils.ts`
  - **Acceptance:** `text` = formatted label, `postalCode` carried, `countryCode` fallback; label parsed only without geography, head and ZIP split off ("Remote in New York, NY 10001" → New York / NY / 10001); legacy option returns exactly `{ city, state, country }`.

- [x] T05 — Utils unit suite
  - **Files:** `packages/plugins/source-indeed/__tests__/indeed.utils.spec.ts`
  - **Acceptance:** 28/28; the `DSQF7`, `CF3CP` and label-only `Temporary` cases return `false` / `null` on HEAD.

## Phase 2 — Diagnostics and posted time

- [x] T06 — Diagnostics module
  - **Files:** `packages/plugins/source-indeed/src/indeed.diagnostics.ts`
  - **Acceptance:** block page (403 or 200) → `blocked` with a `cloudflare` marker; 400 validation → `bad_input` naming the field; `CSRF_ERROR`/`UNAUTHENTICATED`/`FORBIDDEN` → `blocked`; 200 without `data.jobSearch` → never silent; timeouts and network errors keep their classification; detail ≤ 300 chars.

- [x] T07 — Service wiring
  - **Files:** `packages/plugins/source-indeed/src/indeed.service.ts` (UTF-8 BOM kept)
  - **Acceptance:** switches read per scrape; `postedFromTimestamp(datePublished ?? dateOnSite, fetchedAt)` + `postedTimeFields`; GraphQL errors next to data reported only for zero jobs; a page where every job fails to map reports `unknown`; page cap; sleep only when another page follows; jobs kept on a later-page failure.

- [x] T08 — Fixtures
  - **Files:** `packages/plugins/source-indeed/__tests__/fixtures/{indeed-jobsearch-page1.json,indeed-jobsearch-page2.json,indeed-graphql-validation-error.json,indeed-waf-block.html}`
  - **Acceptance:** synthetic pages in the shape the current document requests (fake companies and keys, one duplicate key per page); the block page trimmed from the 2026-09-24 probe with the ray id and client address removed.

- [x] T09 — Unit suites
  - **Files:** `packages/plugins/source-indeed/__tests__/indeed.diagnostics.spec.ts`, `packages/plugins/source-indeed/__tests__/indeed.service.spec.ts`
  - **Acceptance:** 18/18 and 23/23; the POSTed document, variables and filters are asserted equal to HEAD's.

## Phase 3 — Live check and docs

- [x] T10 — Live e2e
  - **Files:** `packages/plugins/source-indeed/__tests__/indeed.e2e-spec.ts`
  - **Acceptance:** `resultsWanted: 3`; a remote search is never a silent empty (tolerates `blocked`); workplace and posted-time contracts checked when jobs come back. Run once 2026-09-25: 2/2, both requests 403 → `blocked` with the `cloudflare` marker.

- [x] T11 — Type-check
  - **Acceptance:** `tsc --project tsconfig.typecheck.json --noEmit` reports nothing under `packages/plugins/source-indeed`.

- [x] T12 — Spec folder
  - **Files:** `.specify/specs/1702-indeed-attribute-mapping-and-diagnostics/{spec,plan,tasks}.md`
  - **Acceptance:** open questions Q-1702-1 … Q-1702-6 recorded for `docs/questions.md` (the integrator adds the `docs/log.md`, `docs/index.md` and `docs/questions.md` rows).

## Notes

- The GraphQL request (document, variables, filters, headers, key, user agent) is deliberately
  unchanged; see spec §9 Q-1702-1.
