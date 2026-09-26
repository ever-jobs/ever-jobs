# Plan: 1705 — Welcome to the Jungle: board-wide search, mapping fixes, credential self-heal

| Field        | Value      |
| ------------ | ---------- |
| Spec         | spec.md    |
| Spec ID      | 1705       |
| Status       | done       |
| Created      | 2026-09-25 |
| Last updated | 2026-09-25 |

## 1. Approach

The three work items land in the order B, A, C, because board search (A) reuses every mapping fix
(B), and the self-heal (C) wraps the single query path both modes share.

The mapping logic moves out of the service into pure, total helpers in `wttj.mapper.ts`, so each
table (remote tokens, contract types, salary shapes, description layout, offices, company metadata)
is tested directly. The service keeps its structure and method names; `normaliseHit` calls the
helpers and `processJob` spreads the new optional fields only when they are set, so a hit without
them serialises as before.

Board search is two pure functions in `wttj.query.ts` (`buildBoardQuery`, `planBoardWindow`) and a
page walk in the service (`fetchBoardHits`). Mode selection sits at the top of `scrape()`, before
anything else runs, so the company path is untouched apart from the shared query function.

Every query goes through `queryIndex`, which sends the credentials it read from
`wttj.credentials.ts` as per-request headers and classifies the answer (`ok`, `http`, `transport`,
`rejected`). On `rejected` it asks the credentials module for a refresh (single-flight, cooldown)
and retries once. Callers turn `rejected` into `blocked` and `transport` / `http` into
`classifyScrapeError`.

Each behaviour change has an env switch that restores the old one (spec §7.1), read on every call.

## 2. Phases

### Phase 1 — B: mapping fixes

- Goal: correct and complete hit mapping in both modes.
- Deliverables: `wttj.mapper.ts`, type additions, service wiring, `wttj.mapper.spec.ts`, the
  mapping part of `wttj.service.spec.ts`, synthetic `wttj-hits.json`.
- Exit criteria: remote matrix, description, salary, job type, offices, metadata and URL locale
  tests green; legacy switches restore the old output.

### Phase 2 — A: board-wide search

- Goal: search the whole index through the existing registration.
- Deliverables: `wttj.query.ts`, `scrapeBoard`, `fetchBoardHits`, board constants,
  `wttj.query.spec.ts`, board + mode-selection cases, two live e2e cases.
- Exit criteria: filters, pagination, window, fallback and error paths green; one live board
  search returns mapped jobs.

### Phase 3 — C: credential self-heal and user agent

- Goal: a rotated key heals or is reported as `blocked`; identifying user agent by default.
- Deliverables: `wttj.credentials.ts`, `queryIndex` / `sendQuery`, synthetic
  `wttj-detail-runtime-config.html`, `wttj.credentials.spec.ts`, self-heal service cases.
- Exit criteria: retry with the rediscovered key, one fetch for concurrent refusals, cooldown,
  `blocked` when nothing is found.

## 3. Packages Touched

| Package | Change |
| ------- | ------ |
| `packages/plugins/source-ats-wttj` | mapper, query and credentials modules; service modes; constants; types; four unit suites; e2e cases; fixtures |
| `packages/models` | (no change; uses `JobType.APPRENTICESHIP` and the Spec 1696 enums) |
| `packages/common` | (no change; uses `resolveCompensation`, `parseLocationText`, `postedFromTimestamp`, `pinUrlToHosts`, the ISO table) |
| `packages/plugin` | (no change) |

## 4. Dependencies

| Library | Version | Rationale |
| ------- | ------- | --------- |
| (none)  | —       | Only existing workspace helpers are used. |

## 5. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
| ---- | ---------- | ------ | ---------- |
| Board search adds load on the index | M | M | One request at a time, 0.5–1 s pacing, small pages, capped at the 1,000-hit window and 50 pages |
| A permanently refused key makes every scrape fetch a page | L | M | One refresh per 10 minutes per process, single-flight, no retries, no retry with an unchanged key |
| The runtime-config layout changes | M | L | Scrape reports `blocked`; `WTTJ_CREDENTIALS_SEED_URL` lets an operator point at another page |
| Stricter remote flag changes result counts for remote searches | H | L | Intended; `WTTJ_REMOTE_MODE=legacy` restores the old flag |
| A seed URL from config points off-site | L | H | `pinUrlToHosts` + no query string + redirect pinning to the site |

## 6. Rollback Plan

Every change is behind a switch (spec §7.1); board mode in `scrape()` is opt-in since the review fixup (`WTTJ_BOARD_MODE=on`), the rest default on:
`WTTJ_REMOTE_MODE=legacy`, `WTTJ_DESCRIPTION_LAYOUT=legacy`, `WTTJ_URL_LOCALE_GUARD=off`,
`WTTJ_USER_AGENT_MODE=browser`, `WTTJ_CREDENTIAL_REFRESH=off`. New `JobPostDto` fields are
optional and additive. No data or schema is involved.

## 7. Migration Plan

None. Consumers that treated `isRemote` as "remote-capable" should read `workFromHomeType`
(`Hybrid`) for partial-remote postings.

## 8. Open Questions for Plan

- The non-ATS registration that puts board search in the default fan-out (spec §3) needs the site
  enum, plugin index, `tsconfig.base.json` and `jest.config.js`; it is left to the integrator.
