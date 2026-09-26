# Tasks: 1704 — Google Jobs rows come from one record each, or not at all

> Status legend: `[ ]` pending • `[~]` in-progress • `[x]` done • `[-]` dropped

## Phase 1 — parser and constants

- [x] T01 — Balanced-bracket scanner
  - **Files:** `packages/plugins/source-google/src/google.parser.ts`
  - **Acceptance:** `findArrayEnd` / `extractBalancedArray` ignore brackets and escaped quotes inside strings; return -1 / `null` for a non-`[` start, an out-of-range start, an unterminated array or a scan past `maxChars`.
- [x] T02 — Shape predicate `isJobRecord`
  - **Files:** `google.parser.ts`
  - **Acceptance:** ≥ 13 entries, non-blank `[0..2]`, http(s) `[3][0][0]`; `[28]` optional; a record starting `["` passes and a `[[[`-anchored wrapper fails.
- [x] T03 — `findJobRecords`: known keys, then shape fallback
  - **Files:** `google.parser.ts`, `google.constants.ts`
  - **Acceptance:** known key yields records without fallback; rotated key yields the same records with `viaFallback: true`; known key with no job-shaped value falls back; nested keys inside an accepted record are skipped; per-record limit, page budget and candidate cap hold; 20 000 never-closing keys parse to `[]` in < 2 s.
- [x] T04 — Cursor and interstitial readers
  - **Files:** `google.parser.ts`
  - **Acceptance:** cursor read regardless of attribute order/quotes, `null` when missing or blank; interstitial true for the unusual-traffic page, the JS-required refresh, 429 and a `/sorry/` final URL, false for results pages.
- [x] T05 — Row mapping
  - **Files:** `google.parser.ts`
  - **Acceptance:** `go-<[28]>` ids stable across parses, URL-hash fallback only without `[28]`; Austin/TX/United States parsed; `Anywhere`/`Remote`/`Work from home`/`WFH` remote with no city; fields trimmed; per-page dedupe.
- [x] T06 — Env switches
  - **Files:** `google.constants.ts`
  - **Acceptance:** `EVER_JOBS_GOOGLE_LEGACY_PARSER` true only for `true`/`1`/`yes`/`on`; `EVER_JOBS_GOOGLE_MAX_PAGES` accepts positive integers, default 10 otherwise.

## Phase 2 — service wiring and diagnostics

- [x] T07 — Record read path in `GoogleService`
  - **Files:** `google.service.ts`, `index.ts`
  - **Acceptance:** title→URL pairs exact on the synthetic page; the record without a URL skipped; no `google.com/search` URL; same request as before; `googleSearchTerm` still overrides.
- [x] T08 — Cursor-gated, capped, deduping loop
  - **Files:** `google.service.ts`
  - **Acceptance:** no cursor → one request, no sleep; with a cursor the old loop runs, dedupes across pages and stops on a page with no new rows; `resultsWanted` honoured mid-page; cap from env and default.
- [x] T09 — Diagnostics
  - **Files:** `google.service.ts`
  - **Acceptance:** interstitial or `/sorry/` first page → `blocked`; no payload and no cursor → `unknown` with detail; cursor without records → `unknown` with its own detail; 3 failed follow-ups after rows → `partial`, rows kept; one recovered failure → no diagnostic; first-page network error → `fetch_error`; first-page 429 from `/sorry/` → `blocked`; 404 → `bad_input`.
- [x] T10 — Legacy path behind `EVER_JOBS_GOOGLE_LEGACY_PARSER`
  - **Files:** `google.service.ts`
  - **Acceptance:** the same synthetic page misattributes the SRE row's URL and emits UI strings as rows (proves the old defect and that the path is reachable); silent `[]` and the ungated loop preserved; page cap applies.

## Phase 3 — e2e gate and docs

- [x] T11 — Gate the live e2e behind `RUN_NETWORK_E2E`
  - **Files:** `packages/plugins/source-google/__tests__/google.e2e-spec.ts`
  - **Acceptance:** skipped by default; when run, `go-` ids, http(s) URLs never a search URL, diagnostic on zero rows.
- [x] T12 — Spec, plan, tasks
  - **Files:** `.specify/specs/1704-google-jobs-record-extraction/`
  - **Acceptance:** 38 parser + 27 service cases green; e2e skipped; type-check shows no `source-google` errors.
- [x] T13 — `docs/index.md` and `docs/log.md` rows (integrator).

## Notes

- Fixtures are synthetic, built from the documented record layout; no captured Google page is committed.
