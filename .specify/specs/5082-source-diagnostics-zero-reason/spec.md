# Spec: 5082 — Per-source zero-jobs reason diagnostics

| Field          | Value                              |
| -------------- | ---------------------------------- |
| Spec ID        | 5082                               |
| Slug           | source-diagnostics-zero-reason     |
| Status         | in-progress                        |
| Owner          | agent                              |
| Created        | 2026-06-28                         |
| Last updated   | 2026-06-28                         |
| Supersedes     | (none)                             |
| Related specs  | 5077, 5081                         |

## 1. Problem Statement

A source that returns 0 jobs is indistinguishable today from a source that failed. All of these collapse to the same empty `jobs: []`:

- the headful/headless browser failed to launch (e.g. Playwright's Chromium binary is not installed),
- the site served a bot challenge (Cloudflare / "Just a moment" / captcha),
- the board loaded fine but genuinely has no open postings,
- the fetch errored (DNS / connection / HTTP 4xx-5xx),
- the per-source deadline was exceeded,
- the input could not resolve a slug/tenant.

Two concrete defects make this worse:

1. **The real error message is discarded.** Browser-based plugins catch every error and log only the constructor name (`errorLabel(err)` → `"Error"`), then `return new JobResponseDto([])`. The one useful string (e.g. "browserType.launchPersistentContext: Executable doesn't exist … run npx playwright install") is thrown away.
2. **The reason never reaches the caller.** Reasons live only in the API server's stdout across ~160 interleaved sources. The `/api/jobs/search` response carries only a flat `jobs` array and aggregate counts — no per-source outcome — so a downstream caller (fetch1) sees `0 jobs total` with no explanation.

Observed live: `desktopmetal`, `gusto_hosted` (two boards), and `truemetalsupply` all failed on the headful browser launch in 3-8 ms (far too fast to be a network/challenge event), each logged only as `scrape failed (Error)`.

## 2. Goals

- Attach a structured, categorized **reason** to every source outcome, including the real error message (truncated).
- Surface a per-source breakdown on the `/api/jobs/search` HTTP response so a caller can print *why* a source returned zero.
- Stop swallowing the underlying error message in the browser-based plugins; classify launch failures as `browser_unavailable` and detected bot challenges as `blocked`.
- Keep everything **additive and backward-compatible** — existing `jobs` / `count` fields unchanged; existing `searchJobs()` callers unaffected.

## 3. Non-Goals

- No change to what jobs are scraped or how they are parsed/mapped.
- No new source plugin; no fix to the browser-launch failure itself (that is an operator step: `npx playwright install chromium`).
- No change to the GraphQL or CLI response shapes (they keep calling `searchJobs()` for the flat array).
- No per-source reason on a cache hit (a cache hit means no fan-out ran).

## 4. Reason categories

A small closed set (`ScrapeReason`):

- `ok` — one or more jobs returned.
- `empty` — source ran and parsed successfully but returned zero results.
- `blocked` — response looks like a bot challenge (Cloudflare / captcha / "just a moment").
- `browser_unavailable` — the headless/headful browser could not launch (binary missing, launch/persistent-context failure).
- `fetch_error` — network/DNS/HTTP transport failure.
- `timeout` — per-source deadline or request timeout.
- `bad_input` — no usable slug/tenant/domain could be resolved from the request.
- `unknown` — an error that did not match any classifier rule (message still carried in `detail`).

## 5. Changes

1. **`@ever-jobs/models`** — new `scrape-diagnostics.dto.ts`:
   - `ScrapeReason` string-union type.
   - `ScrapeDiagnostics { reason: ScrapeReason; detail?: string }`.
   - `SourceDiagnosticDto { site: string; count: number; reason: ScrapeReason; detail?: string }`.
   - Pure helpers `classifyScrapeError(err): ScrapeDiagnostics` (message-pattern → reason) and `looksLikeChallenge(html): boolean`.
   - Export from `dtos/index.ts`.

2. **`JobResponseDto`** — add optional `diagnostics?: ScrapeDiagnostics`; a plugin MAY set it (default undefined, so no plugin is forced to change).

3. **Browser plugins** (`source-company-desktopmetal`, `source-company-truemetalsupply`, `source-ats-gusto-hosted`):
   - `catch` blocks log `classifyScrapeError(err).detail` (the real message) and `return new JobResponseDto([], classifyScrapeError(err))`.
   - the "0 postings parsed" path returns `blocked` when `looksLikeChallenge(html)`, else `empty`.
   - the "no slug/tenant" early return sets `bad_input`.

4. **`JobsService`** — add `searchJobsWithDiagnostics(input): Promise<{ jobs: JobPostDto[]; perSource: SourceDiagnosticDto[] }>`; `searchJobs()` delegates and returns `.jobs` (all six existing callers unchanged). `perSource` is derived from the existing `results` + `selectedScrapers`:
   - fulfilled + count > 0 → `ok`;
   - fulfilled + count 0 → the plugin's `diagnostics` if present, else `empty`;
   - rejected → `classifyScrapeError(reason)` (deadline-skip → `timeout`).

5. **`JobsController.searchJobs`** — on the fresh-scrape path, call `searchJobsWithDiagnostics`, and include `per_source: SourceDiagnosticDto[]` on both the standard and paginated JSON responses. Cache hit → `per_source: []`.

## 6. Test Plan

- `classifyScrapeError` unit tests: playwright launch string → `browser_unavailable`; timeout → `timeout`; ECONNREFUSED/ENOTFOUND → `fetch_error`; 403/cloudflare → `blocked`; unmatched → `unknown` with `detail` preserved.
- `looksLikeChallenge` unit tests: Cloudflare interstitial → true; a normal board page → false.
- Each browser plugin: existing tests still pass; add one test asserting a thrown launch error yields `JobResponseDto` with `diagnostics.reason === 'browser_unavailable'`.
- `JobsService`: a fulfilled empty source → `per_source` reason `empty`; a rejected source → classified reason; a source with jobs → `ok`.
- `npx tsc --noEmit --project tsconfig.base.json` clean; `npm run lint:docs` clean.

## 7. Downstream (fetch1, out of this repo)

`get-from-ever-jobs.py` reads `per_source` and prints the reason next to each domain's count, plus a zeros-only run summary. Tracked in fetch1; no code here depends on it.
