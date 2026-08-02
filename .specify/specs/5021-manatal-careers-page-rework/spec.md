# Spec: 5021 — Manatal rework to careers-page.com JSON API + full ATS field mappings

| Field | Value |
| --- | --- |
| Spec ID | 5021 |
| Slug | manatal-careers-page-rework |
| Status | implemented |
| Owner | agent |
| Created | 2026-06-24 |
| Last updated | 2026-06-24 |
| Related specs | 5004, 5014, 5015, 5016, 5018, 5019, 5020 |

## Problem

The `source-ats-manatal` plugin fetched
`GET https://api.manatal.com/open/v1/career-page/{slug}/jobs/` and expected JSON.
For real Manatal customers (e.g. `castelion-corporation`, 135 live jobs) that
endpoint now returns the **SPA HTML shell**, not JSON — so the plugin returns
**0 jobs for every company**.

Manatal hosts its public career pages on the white-label domain
`careers-page.com`. The working data layer — the one the Vue front-end itself
consumes — is the careers-page.com JSON API:

```
list:   GET https://www.careers-page.com/api/v1.0/c/{slug}/jobs/[?page=N]
```

The list response is **self-contained**: full HTML description, structured
location (`city`/`state`/`country`), and salary fields (only when
`is_salary_visible`). No per-job detail fetch is required (unlike Paylocity /
BambooHR).

## Findings — where the data actually lives

`GET /api/v1.0/c/{slug}/jobs/` → `{ count, next, previous, results[] }`:

- `next` — absolute URL of the next page, or `null` on the last page
  (pagination is via `?page=N`, 1-based; omitted for page 1).
- each `results[]` job:
    - `id` (number) — stable ATS id; `hash` (string) — short code used in the
      public job URL `careers-page.com/{slug}/job/{hash}`.
    - `position_name` — title.
    - `description` — full HTML body of the posting.
    - `country` / `state` / `city` / `address` / `zipcode` — structured
      location; `location_display` — pre-joined "City, State, Country".
    - `is_salary_visible` (bool). **Only when true** are `salary_min` /
      `salary_max` present, serialised as **decimal strings** (e.g.
      `"60000.00"`) with `currency_code` (e.g. `"USD"`).
    - **No** employment-type, department, job-function, remote flag, or posted
      date are exposed anywhere in the payload.

Observed real values (captured fixtures):

- castelion-corporation: id `3880458` $40–$50 (hourly-scale), id `3587114`
  (hash `W3647W96`) $140k–$180k (yearly-scale) — both `is_salary_visible`.
- ghostwerks-llc: id `3419131` $60k–$85k visible; other 5 not visible.
- calqulate: none `is_salary_visible`, but several descriptions carry a text
  range (e.g. `"Base salary range: $65,000 – $90,000 annually"`).

## Scope

Repoint the plugin at the careers-page.com JSON API and apply the standard ATS
checklist, reusing shared
helpers (Specs 5018–5019 compensation, common location parser, `extractEmails`).

- **`companySlug` = the careers-page.com client slug** (first path segment of
  `careers-page.com/{slug}`). Empty slug → empty result (unchanged contract).
- **List fetch + pagination.** `GET /api/v1.0/c/{slug}/jobs/`, then follow the
  `next` link until enough jobs are gathered, `next` is exhausted, or the page
  cap `MANATAL_MAX_PAGES = 50` is hit (safety valve against a runaway chain).
  No detail fetch — the list is self-contained.
- **Compensation — structured-first, text-fallback** via the shared
  `resolveCompensation`:
    - structured only when `is_salary_visible`; decimal-string amounts coerced
      to numbers (`toAmount`), `currency` ← `currency_code` (default `USD`).
    - the API omits the pay **interval**, so it is inferred from the amount
      magnitude using the **same thresholds as the shared text parser**
      (`< 350` hourly, `< 30000` monthly, else yearly).
    - when salary is not visible, fall back to parsing the description text.
    - `salarySource` records which path won (`structured` | `description`).
- **Location.** Prefer the structured `city`/`state`/`country`; fall back to
  `parseLocationText(location_display)` when all three are empty.
- **Remote.** The API has no remote flag, so `isRemote` / `workFromHomeType`
  are inferred from the location text via the shared parser (only emitted when
  detected).
- **Description.** `descriptionFormat`: HTML passthrough / `markdownConverter` /
  `htmlToPlainText` (default), from the self-contained list body.
- **Emails** ← `extractEmails` on the plain-text description.
- **URLs.** `companyUrl` ← `careers-page.com/{slug}`; `jobUrl` ←
  `careers-page.com/{slug}/job/{hash}`. No `applyUrl` (applicants apply on the
  job page); no `companyUrlDirect`.
- **Never fabricate** employment_type / jobFunction / department / datePosted —
  the payload lacks them, so the fields are left unset (checklist rule).
- **Types / constants** rewritten to the careers-page.com shapes
  (`ManatalResponse`, `ManatalJob`; `MANATAL_API_BASE`, `MANATAL_SITE_BASE`,
  URL builders, `MANATAL_MAX_PAGES`, `MANATAL_HEADERS`).

## Non-goals

- **No attempt to revive `api.manatal.com`.** It serves the SPA shell for these
  slugs; careers-page.com is the supported public path. (Recorded in
  `docs/questions.md`.)
- **No per-job detail fetch.** The list payload is complete.
- **No `companySlug` auto-discovery.** The slug is supplied by the caller (the
  upstream detector extracts it from the careers-page link).
- **No employment-type / job-function / datePosted synthesis.** Not in payload.
- **No change to other ATS plugins.**

## Contracts

| Input | title | location | description | compensation | salarySource | isRemote |
| --- | --- | --- | --- | --- | --- | --- |
| salary visible | `position_name` | city/state/country | body (per format) | `salary_min`/`max`, inferred interval | `structured` | from `location_display` |
| not visible, text range | `position_name` | city/state/country | body | parsed from text | `description` | — |
| not visible, no text | `position_name` | city/state/country | body | omitted | omitted | — |
| remote in location text | — | parsed | — | — | — | true, `workFromHomeType=Remote` |
| empty slug / fetch error | — | — | — | — | — | — (returns `[]`) |

## Test plan

Fixture-driven unit tests (mocked HTTP, no network) using real captured API
responses under `__tests__/fixtures/` (ghostwerks, calqulate, castelion p1+p2):

- **ghostwerks (6 jobs)** → all mapped; stable `manatal-{id}` ids, `companyUrl`
  / `jobUrl` (hash-based) shapes, structured location (Wharton, New Jersey,
  United States); the visible job (`3419131`) → `$60k–$85k` yearly USD,
  `salarySource = structured`; a non-visible job (`3226536`) → no compensation;
  emails include `info@ghostwerksllc.com`.
- **calqulate (10 jobs)** → the non-visible job `3550612` → compensation parsed
  from the description text (`$65k–$90k`), `salarySource = description`.
- **castelion p1+p2** → hourly interval inference (`3880458` → $40–$50 hourly),
  yearly (`3587114` → $140k–$180k yearly); pagination follows `next` once when
  `resultsWanted = 15` (2 GETs, 15 jobs); does not page when page 1 already
  satisfies the request.
- **synthetic remote job** → `isRemote = true`, `workFromHomeType = Remote`.
- **empty companySlug** → `[]`, no HTTP call. **fetch error** → `[]`.
- **descriptionFormat** → HTML passthrough vs PLAIN strips tags.

A network smoke test (`manatal.e2e-spec.ts`) is gated behind `RUN_NETWORK_E2E`.
