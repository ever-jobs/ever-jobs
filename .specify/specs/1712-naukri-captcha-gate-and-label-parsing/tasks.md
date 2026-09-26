# Tasks: 1712 — Naukri reports its captcha gate as `blocked` and parses its labels correctly

> Status legend: `[ ]` pending • `[~]` in-progress • `[x]` done • `[-]` dropped

## Phase 1 — Parsers and service

- [x] T01 — Typed wire shapes.
  - **Files:** `packages/plugins/source-naukri/src/naukri.types.ts`
  - **Acceptance:** `NaukriPlaceholder`, `NaukriJobDetail`, `NaukriSearchResponse` (with `message` / `statusCode` for the refusal body) replace `any` in the new mapping.

- [x] T02 — Constants and the two compatibility switches.
  - **Files:** `packages/plugins/source-naukri/src/naukri.constants.ts`
  - **Acceptance:** `NAUKRI_HEADERS` unchanged; origin, search URL, page size 20, 50-page cap, 20 s default timeout, 3 + 4 s delay band; `NAUKRI_PARSER` / `NAUKRI_DIAGNOSTICS` (`current` | `legacy`) with `parseNaukriMode` returning `null` for an unknown value.

- [x] T03 — `detectNaukriBlock`.
  - **Files:** `packages/plugins/source-naukri/src/naukri.parsers.ts`
  - **Acceptance:** 406/403, a `/captcha/i` body message (object or JSON text, thrown or 200) and a challenge page match with `HTTP <status>: <message>` ≤ 300 chars; 404, timeouts, resets and normal bodies do not.

- [x] T04 — `parseNaukriSalary`.
  - **Files:** `packages/plugins/source-naukri/src/naukri.parsers.ts`
  - **Acceptance:** the design's table (range, per-bound units, up to, LPA, Lakhs, Crore, Indian grouping, `P.M.`) plus `to`, en dash, `Upto`, `0-3 Lacs`; `null` for undisclosed, `3-5`, inverted ranges and over-long labels; never `NaN`.

- [x] T05 — `parseNaukriLocationLabel`.
  - **Files:** `packages/plugins/source-naukri/src/naukri.parsers.ts`
  - **Acceptance:** multi-city split with India on each entry; `Hybrid - …` never yields a state; `Remote` / `WFH` / `Temp. WFH` remote; `Work from office` recorded; parenthetical qualifiers read, other parentheticals dropped; one literal country folded onto the cities; description never read.

- [x] T06 — `parseNaukriPostedDate` and the `hoursOld` cutoff.
  - **Files:** `packages/plugins/source-naukri/src/naukri.parsers.ts`
  - **Acceptance:** IST day; open-ended / missing / unparseable labels defer to a plausible `createdDate` (ms or seconds, 2000 … now + 1 day); month boundary and the IST-midnight case from the design.

- [x] T07 — Service.
  - **Files:** `packages/plugins/source-naukri/src/naukri.service.ts` (BOM and LF kept)
  - **Acceptance:** blocked diagnostics on throw and on 200; `fetch_error` for non-JSON 200; dead status branch gone; timeout default 20 s and honoured with proxies; caller UA header; offset remainder skip (consumed ids still dedupe); `noOfJobs` stop hint; client-side `hoursOld` filter; `URL`-resolved links; `PLAIN` via `htmlToPlainText`; skills / rating / reviews / vacancy coercion; no delay after the last page; pre-1712 methods kept verbatim for `NAUKRI_PARSER=legacy`.

## Phase 2 — Tests and docs

- [x] T08 — Synthetic fixtures.
  - **Files:** `packages/plugins/source-naukri/__tests__/fixtures/naukri-search-page1.json`, `naukri-search-406-recaptcha.json`
  - **Acceptance:** 7 rows (5 valid, a duplicate id, an id-less row); invented company names; the 50-byte refusal body.

- [x] T09 — Parser suite.
  - **Files:** `packages/plugins/source-naukri/__tests__/naukri.parsers.spec.ts`
  - **Acceptance:** 90/90.

- [x] T10 — Service suite.
  - **Files:** `packages/plugins/source-naukri/__tests__/naukri.service.spec.ts`
  - **Acceptance:** 40/40, including diagnostics (a)–(j) and both legacy modes. A control run of the pre-1712 service over the same scenarios gave `bad_input` for the 406, `isRemote: true` / `Remote` for row 4, one location for row 1, no salary interval and a corrupted absolute URL — the values the legacy-mode tests pin.

- [x] T11 — E2E assertion.
  - **Files:** `packages/plugins/source-naukri/__tests__/naukri.e2e-spec.ts`
  - **Acceptance:** passes only on well-formed jobs, or zero jobs with `blocked` / `timeout`; 90 s jest timeout; `resultsWanted: 3`, `requestTimeout: 20`. Live run 2026-09-25: passed in ~23 s (one request).

- [x] T12 — Type-check and spec folder.
  - **Files:** `.specify/specs/1712-naukri-captcha-gate-and-label-parsing/{spec,plan,tasks}.md`
  - **Acceptance:** `tsc --project tsconfig.typecheck.json` reports no error in `source-naukri`.

## Notes

- `docs/index.md` / `docs/log.md` rows are added with the integrating commit.
- Follow-ups (out of scope): let `classifyScrapeError` read a string `response.data.message`; make
  `createHttpClient` honour `timeout ?? requestTimeout` with proxies (same call shape in other
  plugins); add `crawl: { maxConcurrentPerHost: 1, minIntervalMs: 3000 }` once `IPluginMetadata`
  has the field; promote `parseNaukriSalary` to `packages/common` when a second consumer appears;
  consider emitting the Spec 1696 posted-time detail fields (`createdDate` is an exact instant).
