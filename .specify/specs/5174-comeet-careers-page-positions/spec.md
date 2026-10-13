# Spec: 5174 — comeet-careers-page-positions

| Field | Value |
| --- | --- |
| Spec ID | 5174 |
| Slug | comeet-careers-page-positions |
| Status | draft |
| Owner | agent |
| Created | 2026-10-09 |

## Problem

`source-ats-comeet` has never returned a job. `comeet.service.ts` calls

    https://www.comeet.com/careers-api/2.0/company/{companySlug}/positions?token=

with a literal empty `token=` and `companySlug` in the `{company}` path
segment — but the endpoint wants a `company_uid` (`3B.00F`), not the board
slug. Verified live: the call returns `{"status":400,"Token is missing"}` →
`classifyScrapeError` → `JobResponseDto([])` on every scrape. The plugin has
no way to learn `company_uid` or the token because it never fetches a
careers page.

Meanwhile the real board data is embedded in the careers page itself:
`covenant.com/careers` → 302 → `www.comeet.com/jobs/covenantindustries/3B.00F`,
whose HTML carries `COMPANY_DATA = {…, "company_uid": "3B.00F", "token": …}`
and `COMPANY_POSITIONS_DATA = [{…31 items}]` — every field the plugin maps
plus more (`location` object with `name`/`city`/`state`/`postal_code`/
`street_name`/`timezone`/`location_uid`/`is_remote`, `workplace_type`,
`employment_type`, `custom_fields.details` — a `[{name, value}]` section list
with the full HTML description, identically shaped to the API's `details[]`).

## Scope

Replace the careers-api call with a careers-page fetch + embedded-payload
parse:

- **Page URL** — `input.companyUrl` when set (Spec-006 portal field),
  else `https://www.comeet.com/jobs/{companySlug}`. The fetch follows
  redirects, so a company domain that 302s to the comeet board works too.
- **Extraction** — bracket-balanced `COMPANY_POSITIONS_DATA` / `COMPANY_DATA`
  assignment parse (values are strict JSON; a small string-aware brace walk
  in the service — no shared helper exists).
- **Per position** — `name`→title, `uid`→`atsId` and `comeet-{slug}-{uid}` id
  (identity unchanged), `url_active_page`→`jobUrl` + `applyUrl`,
  `company_name`→`companyName` (fallback `COMPANY_DATA.name` → slug),
  `department`, `time_updated`→`datePosted`,
  `custom_fields.details[].value`→`stripHtmlTags` description (same shape as
  the old `details[]` path).
- **Location** — `toLocationDto(position.location, { textKeys: ['name'], parseTextFallback: true })`;
  `locations: [dto]` when non-null. `city`/`state`/`country`/`postal_code`
  are default aliases; `timezone`/`location_uid`/`is_remote`/`street_name`
  land in `extras`.
- **`isRemote`** — `location.is_remote === true` or `workplace_type` matches
  /^remote$/i — replaces the location-label string match.
- **`employmentType`** — `employment_type` (null on the verified feed; field
  mapped when present).
- **Preserved** — `resultsWanted`, `classifyScrapeError`, the
  resolve-not-throw catch, the `companySlug` requirement (id prefix +
  fallback URL).

## Non-goals

- No `careers-api` call — the token path is removed; the embedded payload is
  complete.
- No per-position detail fetch.
- No `companyDomains` changes (a generic ATS plugin doesn't claim company
  domains).
- No fields for `email`/`experience_level`/`is_internal`/`picture_url`/
  `linkedin_job_posting_id` — no `JobPostDto` slots.

## Contracts

- `JobPostDto` output shape unchanged; `id` still `comeet-{slug}-{uid}` —
  `dedupKey` is not expected to shift (same `location`/`locations[]` mapping
  semantic: one site per position).
- A page without comeet markers returns `JobResponseDto([])` with a warn log
  (soft-404 board), not a classified error; fetch failures still classify.

## Test plan

- Captured-page fixture (`__tests__/fixtures/comeet-careers.html`) embedding
  `COMPANY_DATA` + two real `COMPANY_POSITIONS_DATA` items — asserts
  title/id/jobUrl/applyUrl/department/datePosted/description/location/
  employmentType mapping.
- `isRemote` via an inline page with `is_remote: true` /
  `workplace_type: "Remote"`.
- `companyUrl` honoured; `locations[]` single-element shape; `resultsWanted`
  break; no-markers page → empty response; fetch failure → classified error.
