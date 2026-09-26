# Tasks: 1710 — Bayt: correct search URLs and card mapping, and a challenge is never an empty board

> Status legend: `[ ]` pending • `[~]` in-progress • `[x]` done • `[-]` dropped

## Phase 1 — Pure parsing

- [x] T01 — Constants and option resolution.
  - **Files:** `packages/plugins/source-bayt/src/bayt.constants.ts`
  - **Acceptance:** base URL, HTML `Accept` + `Accept-Language`, eight-market table, ten regional countries, page cap 10 (ceiling 50), 2–5 s delay, default 15 rows; `resolveBaytOptions` takes an override, then `EVER_JOBS_BAYT_LEGACY_MAPPING` / `_LEGACY_SLUG` / `_COUNTRY_SCOPE` / `_MAX_PAGES`, then the default; junk keeps the default.

- [x] T02 — Slug and search URL.
  - **Files:** `packages/plugins/source-bayt/src/bayt.parse.ts`
  - **Acceptance:** `toBaytSlug` gives `strasse-manager`, `aero-pilot`, `lodz-analyst`, `ingenieur-logiciel`, `c-developer`, `front-end-ui`, `nodejs`, `data-scientist`, `istanbul-sales`, and `''` for `---` / `مهندس` / `+++`; `buildSearchUrl('international','software-engineer',1)` is exact; the empty slug browses; no built path starts with `/en/jobs/` or spells `filters[` / `options[`.

- [x] T03 — Market resolution.
  - **Files:** `packages/plugins/source-bayt/src/bayt.parse.ts`
  - **Acceptance:** UAE → `uae`, SAUDIARABIA → `saudi-arabia`, GERMANY / WORLDWIDE / USA → `international`; `location: 'Dubai, UAE'` → `uae`, also when `country` is the DTO default; a Bayt-market `country` beats `location`.

- [x] T04 — Card parsing and mapping.
  - **Files:** `packages/plugins/source-bayt/src/bayt.parse.ts`, `__tests__/fixtures/*.html`
  - **Acceptance:** ids from `data-job-id`, then URL digits, then hash; canonical URLs strip query and fragment and never double the host; titles collapsed; two-anchor and `·` locations split; a regional state promoted to country; `Remote` sets `remoteMentioned`; empty cell → `null`; posted labels incl. `30+ days ago` and labels inside longer text; `toJobPost` fills `datePosted` + Spec 1696 precision/basis.

- [x] T05 — Fetch diagnostics.
  - **Files:** `packages/plugins/source-bayt/src/bayt.parse.ts`
  - **Acceptance:** `cf-mitigated: challenge` (plain object, any header case, array value, or `AxiosHeaders`-style getter) → `blocked` with the managed-challenge detail; a challenge body on another status → `blocked`; otherwise `classifyScrapeError`.

- [x] T06 — Pure suite.
  - **Files:** `packages/plugins/source-bayt/__tests__/bayt.parse.spec.ts`
  - **Acceptance:** 86/86.

## Phase 2 — Service loop

- [x] T07 — Transport fix.
  - **Files:** `packages/plugins/source-bayt/src/bayt.service.ts`
  - **Acceptance:** `createHttpClient` gets `requestTimeout` and `userAgent` (no `timeout` key) with proxies set; `setHeaders` gets the HTML `Accept` and `Accept-Language`, no UA and no `sec-*` header.

- [x] T08 — Input guards.
  - **Files:** `packages/plugins/source-bayt/src/bayt.service.ts`
  - **Acceptance:** a non-empty term with an empty slug, or a robots-refused path, returns `[]` + `bad_input` with zero requests.

- [x] T09 — Page loop.
  - **Files:** `packages/plugins/source-bayt/src/bayt.service.ts`
  - **Acceptance:** sequential (max one in flight), sleep only between pages, cross-page dedup, stop on a page with no new id, `offset`, `resultsWanted` (default 15), page cap 10 and `EVER_JOBS_BAYT_MAX_PAGES`; `hoursOld` client-side with undated cards kept.

- [x] T10 — Outcome classification.
  - **Files:** `packages/plugins/source-bayt/src/bayt.service.ts`
  - **Acceptance:** 200 challenge → `blocked`; 403 `cf-mitigated` → `blocked`; partial page-1 jobs + `blocked`; 404 → `bad_input`; empty page → no diagnostic; all-broken page → `unknown` naming card count and page.

- [x] T11 — Legacy switches.
  - **Files:** `packages/plugins/source-bayt/src/bayt.parse.ts`, `src/bayt.service.ts`
  - **Acceptance:** `EVER_JOBS_BAYT_LEGACY_MAPPING=true` emits the pre-1710 id / title / jobUrl / location verbatim; `legacySlug` + `countryScope: false` request `/en/international/jobs/Python-Developer-jobs/?page=1`.

- [x] T12 — Service suite.
  - **Files:** `packages/plugins/source-bayt/__tests__/bayt.service.spec.ts`
  - **Acceptance:** 30/30; mutating five fixes turns 12 cases red.

## Phase 3 — Live gate and docs

- [x] T13 — Gate the live e2e.
  - **Files:** `packages/plugins/source-bayt/__tests__/bayt.e2e-spec.ts`
  - **Acceptance:** skipped without `RUN_NETWORK_E2E`; with it, passes on well-formed jobs or `blocked`, fails on zero jobs with no diagnostic. One opt-in run (2026-09-25) returned `blocked` with the managed-challenge detail.

- [x] T14 — Spec folder.
  - **Files:** `.specify/specs/1710-bayt-board-correctness-and-diagnostics/{spec,plan,tasks}.md`

- [x] T15 — `docs/index.md` / `docs/log.md` rows (integrator).

## Follow-ups (separate changes)

- [ ] F1 — `createHttpClient` scraper-input branch: `timeout: options.requestTimeout ?? options.timeout`, with a unit test (affects every plugin passing `timeout` alongside `proxies`).
- [ ] F2 — Descriptions at board depth via sequential, capped detail-page fetches and the shared `JobPosting` JSON-LD helpers, once the source is reachable.
- [ ] F3 — Add the Levant / North-Africa countries to `Country` + `COUNTRY_CONFIG`; drop `BAYT_EXTRA_COUNTRIES`.
- [ ] F4 — When the plugin crawl-policy manifest lands: `rateLimitScope: 'domain'`, one per host, 2 s interval + 3 s jitter, `robotsTxt: 'respect'`; drop the in-plugin sleep.
- [ ] F5 — Confirm Q1–Q4 on the first reachable fetch.

Integration 2026-09-25: `docs/index.md` / `docs/log.md` rows and the README Bayt section updated. F1-F5 stay open.
