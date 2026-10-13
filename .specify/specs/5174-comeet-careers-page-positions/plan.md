# Plan: 5174 — comeet-careers-page-positions

| Field | Value |
| --- | --- |
| Spec ID | 5174 |
| Slug | comeet-careers-page-positions |
| Status | draft |
| Owner | agent |
| Created | 2026-10-09 |

## Approach

Single-file rewrite of `comeet.service.ts` (~90 lines → ~150): careers-page
fetch, embedded-JSON extraction, per-position mapping. Plus a new test suite
with a captured fixture — the plugin's first.

## Phases

1. **Extractor** — `extractAssignment(html, 'COMPANY_POSITIONS_DATA')`:
   locate `NAME =`, find the first `[`/`{`, walk with string/escape-aware
   bracket balancing, `JSON.parse` the slice. Same helper serves
   `COMPANY_DATA` (object). Values are strict JSON (verified live).
2. **Fetch** — `companyUrl ?? https://www.comeet.com/jobs/{companySlug}`
   through `createHttpClient` (redirects followed: covenant.com/careers →
   comeet board). Missing markers → warn + `[]` (soft-404), not a classified
   error.
3. **Mapping** — per position as specced; `toLocationDto(position.location, { textKeys: ['name'], parseTextFallback: true })`;
   `isRemote` from `location.is_remote`/`workplace_type`; description from
   `custom_fields.details[].value` via the existing `stripHtmlTags` loop.
4. **Tests** — captured fixture (two real items) + inline remote/marker-free
   cases.
5. **Docs** — `docs/index.md` row, `docs/log.md` entry, `lint:docs`.

## Packages touched

- `packages/plugins/source-ats-comeet/` — `src/comeet.service.ts` (rewrite),
  `__tests__/` (new).

## Risks

- Page shape varies by board theme — mitigated by marker-free → `[]` + warn,
  and by `COMPANY_POSITIONS_DATA` being the SPA's own data source.
- `custom_fields.details` shape may differ across tenants — treated as
  optional (`?? []`); missing → `description: null` like today.
