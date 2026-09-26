# Tasks: 1707 — RemoteOK search recall, text repair, hoursOld and direct-URL semantics

> Status legend: `[ ]` pending • `[~]` in-progress • `[x]` done • `[-]` dropped

## Phase 1 — Pure helpers

- [x] T01 — `repairMojibake` and title cleaning.
  - **Files:** `packages/plugins/source-remoteok/src/remoteok.text.ts`
  - **Acceptance:** two-, three- and four-byte runs, a triple-encoded run (two passes), truncated
    tails stripped on the raw string only, a repaired trailing letter kept, mixed strings, C1
    controls removed; clean text (`Café`, `São Paulo`, `Größe`, `naïve`, CJK) untouched; idempotent;
    no U+FFFD; an 80 KB flagged string in < 2 s. `cleanTitle` collapses whitespace and trims a
    trailing separator run in linear time.

- [x] T02 — Tokens, seed, whole-word matching and tiers.
  - **Files:** `packages/plugins/source-remoteok/src/remoteok.text.ts`
  - **Acceptance:** `Senior Python Developer` → `senior, python, developer`; `C++ / C#` →
    `c++, c#`; `Node.js` kept; stopwords dropped; 16-token cap. Seed `python` for
    `senior python developer`, `software` for `software engineer`, none for `senior engineer`,
    `c++` or `2026`. `java` ∌ `javascript`, `go` ∌ `google`/`argo`/`django`, `engineer` ∋
    `engineers`. Tier 0/1/2/excluded; no word joined across fields.

- [x] T03 — Locations, URLs, salary, feed validation, legacy grammar.
  - **Files:** `packages/plugins/source-remoteok/src/remoteok.text.ts`
  - **Acceptance:** adjacent repeats collapsed, empty parts dropped, `Remoto`/`Worldwide` →
    `Remote`; host lower-cased, non-http(s) refused, relative URLs resolved against the board;
    board index pages rejected as job links; `/remote-jobs/<id>` fallback; `jobUrlDirect` only off
    the board; `(30,36)`, `(10000,750000)`, `(90000,60000)` → `null`, one-sided kept; metadata row
    skipped by shape anywhere; challenge body → error containing `challenge`;
    `EVER_JOBS_REMOTEOK_LEGACY` parsed as all / list / none with unknown parts reported.

## Phase 2 — Service

- [x] T04 — Feed plan and diagnostics.
  - **Files:** `packages/plugins/source-remoteok/src/remoteok.service.ts`
  - **Acceptance:** one tag request when it has jobs; global after an empty tag feed; `partial`
    after a failed tag feed with matches; the tag error (`fetch_error`) when nothing matches;
    `blocked` for a 403 or challenge; `timeout`; a non-array body is not `empty`; no second request
    after a blocked or 429 tag feed.

- [x] T05 — Repair, `hoursOld`, ranking, `offset` / `resultsWanted`.
  - **Files:** `packages/plugins/source-remoteok/src/remoteok.service.ts`
  - **Acceptance:** AND semantics (`senior python` excludes a plain `Python Developer`), a title
    match ranks above a newer description match, tag-only last, company matches; `hoursOld: 24`
    keeps 2 h, drops 30 h, uses `date` without `epoch`, keeps undated rows; `offset 2, results 2`
    over 5 returns #3 and #4; default limit 100.

- [x] T06 — Mapping.
  - **Files:** `packages/plugins/source-remoteok/src/remoteok.service.ts`
  - **Acceptance:** no output string matches `[\xC2-\xF4][\x80-\xBF]`; the Arabic city lands in
    `location.city`; entities decoded in title/company only; board apply link → `applyUrl = jobUrl`,
    `jobUrlDirect = null`; off-board apply link → both; slug and numeric-id fallbacks; `logo`
    fallback; posting time `2026-09-23` + exact instant, `epoch` fallback; `PLAIN` and `MARKDOWN`
    descriptions repaired.

- [x] T07 — Client options.
  - **Files:** `packages/plugins/source-remoteok/src/remoteok.service.ts`,
    `packages/plugins/source-remoteok/src/remoteok.constants.ts`
  - **Acceptance:** caller User-Agent in the request headers and the client; `requestTimeout`
    and `timeout` both passed with proxies set; spacing `1–1.5 s` by default, never below 1 s,
    longer when the caller asks; redirects pinned to `remoteok.com` / `remoteok.io`.

- [x] T08 — Old behaviour reachable.
  - **Files:** `packages/plugins/source-remoteok/src/remoteok.service.ts`,
    `packages/plugins/source-remoteok/src/remoteok.constants.ts`
  - **Acceptance:** `EVER_JOBS_REMOTEOK_LEGACY` = `search`, `text`, `urls`, `salary`, `location`
    each restore their part; `true` restores all at once.

## Phase 3 — Tests and verification

- [x] T09 — Suites and fixtures.
  - **Files:** `packages/plugins/source-remoteok/__tests__/remoteok.text.spec.ts`,
    `remoteok.service.spec.ts`, `fixtures/remoteok-feed.fixture.ts`, `remoteok.e2e-spec.ts`
  - **Acceptance:** 171/171 unit tests passing (swc). Mutation checks — one repair pass, no tail
    strip, no look-behind, always falling back, no `hoursOld` filter, no tiering — each turn the
    suites red. Live e2e 3/3 (honest User-Agent).

- [x] T10 — Before / after, live 2026-09-25 (honest User-Agent, one request per run, ≥ 2.5 s apart).

  | Search term | `resultsWanted` | Before (legacy `true`) | After |
  | ----------- | --------------- | ---------------------- | ----- |
  | `python` | 100 | 4 jobs, 4 with garbled text, 4 board links as `jobUrlDirect` | 100 jobs, 0 garbled, 0 board links as `jobUrlDirect` |
  | `senior python` | 100 | 0 jobs | 55 jobs |

- [x] T11 — Type-check: `npx tsc --project tsconfig.typecheck.json --noEmit`.

## Notes

- `docs/log.md` / `docs/index.md` entries are added with the integrating commit.
