# Tasks: 1705 — Welcome to the Jungle: board-wide search, mapping fixes, credential self-heal

| Field        | Value      |
| ------------ | ---------- |
| Spec         | spec.md    |
| Spec ID      | 1705       |
| Last updated | 2026-09-25 |

> Status legend: `[ ]` pending • `[~]` in-progress • `[x]` done • `[-]` dropped

## Phase 1 — B: mapping fixes

- [x] T01 — Type additions (B7): salary, timestamp, experience, sectors, benefits, geo, contract
  duration, `has_remote`, `wk_reference` on the hit; `logo`, `nb_employees`, `summary` on the
  organization; `key_missions: string[] | string | null`; mapped fields on `WttjJob`.
  - **Files:** `packages/plugins/source-ats-wttj/src/wttj.types.ts`
  - **Acceptance:** type-check clean.
- [x] T02 — Strict remote tokens (B1) with `WTTJ_REMOTE_MODE=legacy` fallback.
  - **Files:** `src/wttj.mapper.ts`, `src/wttj.service.ts`
  - **Acceptance:** `unknown` → not remote (regression case); `partial` / `punctual` → Hybrid; `no`
    beats a remote title; missing token → regex; legacy restores the old flag.
- [x] T03 — Description layout (B2) with `WTTJ_DESCRIPTION_LAYOUT=legacy`.
  - **Acceptance:** summary, `<ul>` missions, profile; escaped text; string missions kept; plain
    and Markdown outputs carry the missions.
- [x] T04 — Structured salary with text fallback (B3).
  - **Acceptance:** yearly / monthly / yearly-minimum shapes; no currency → no structured value and
    the text fallback applies; zero amounts → none.
- [x] T05 — `jobType` table (B4); `employmentType` unchanged.
  - **Acceptance:** all 11 live tokens; unknown token → shared vocabulary → `OTHER`.
- [x] T06 — Offices, country code, company metadata, job function, experience (B5).
  - **Acceptance:** two offices → two locations, primary first; `countryCode` validated.
- [x] T07 — URL locale guard (B6) with `WTTJ_URL_LOCALE_GUARD=off`.
- [x] T08 — Posting instant from `published_at` (Spec 1696 helpers), only when its day matches.

## Phase 2 — A: board-wide search

- [x] T09 — `buildBoardQuery`, sanitisers, country-code resolution, `hasBoardCriteria`.
  - **Files:** `src/wttj.query.ts`, `__tests__/wttj.query.spec.ts`
- [x] T10 — `planBoardWindow` (window cap, offset, smallest one-page size).
- [x] T11 — `scrapeBoard`, `fetchBoardHits`, mode selection in `scrape()` with `WTTJ_BOARD_MODE=off`.
  - **Acceptance:** no company + no criteria → `[]`, no request; company mode body unchanged;
    `offset >= 1000` → `bad_input`; window cut → `partial`; `_fr` only on 404 / 400.
- [x] T12 — Pacing (0.5–1.0 s), capped timeout, identifying user agent, `input.userAgent` override,
  `WTTJ_USER_AGENT_MODE=browser`.
- [x] T13 — Live e2e: two tolerant board cases in `wttj.e2e-spec.ts`; verified live 2026-09-25
  (Paris developer search → 3 mapped jobs).

## Phase 3 — C: credential self-heal

- [x] T14 — `wttj.credentials.ts`: cache, extraction, refusal detection, seed URLs (last served
  detail URL, `WTTJ_CREDENTIALS_SEED_URL`, built-in), single-flight refresh with a 10-minute
  cooldown, reset.
- [x] T15 — `queryIndex` / `sendQuery`: per-request credential headers, one retry with a changed
  key, `blocked` otherwise; `WTTJ_CREDENTIAL_REFRESH=off`.
  - **Acceptance:** retry carries the rediscovered key and DSN host; one page fetch for two
    concurrent refusals; earlier pages kept on a later refusal.
- [x] T16 — Spec, plan and tasks for 1705.

## Not in this lane

- [ ] T17 — Non-ATS job-board registration `Site.WELCOMETOTHEJUNGLE` delegating to `scrapeBoard`
  through the registry (site enum, plugin index, `tsconfig.base.json`, `jest.config.js`, README
  search list), with its unit and e2e suites.
- [x] T18 — `docs/index.md` row and `docs/log.md` entry for Spec 1705.

## Notes

- Tests were written with each task; all fixtures are synthetic.

Integration 2026-09-25: `docs/index.md` / `docs/log.md` rows added. T17 (the `Site.WELCOMETOTHEJUNGLE` job-board registration) stays open.
