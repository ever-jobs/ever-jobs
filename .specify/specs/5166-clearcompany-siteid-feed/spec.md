# Spec: 5166 — ClearCompany per-site (widget) feed via careers site id

| Field | Value |
| --- | --- |
| Spec ID | 5166 |
| Slug | clearcompany-siteid-feed |
| Status | draft |
| Owner | agent |
| Created | 2026-09-30 |
| Related specs | 300 (source-ats-clearcompany) |

## Problem

`source-ats-clearcompany` reads the legacy careers-page feed
(`GET careers-page.clearcompany.com/api/v1/careers/jobs`, tenant via the
`API-ShortName` header). That feed can **under-report** the jobs a tenant
actually publishes: postings published only to the tenant's newer widget/portal
site are absent from it — observed live: 127 jobs via API-ShortName vs 158 via
the widget feed for the same tenant, the latter a strict superset.

The complete feed is per-site:

    GET https://careers-api.clearcompany.com/v1/{siteId}
      → { results: [...], totalCount, currentPageIndex, currentPageCount }

where `siteId` is the GUID from the tenant's embed snippet
(`careers-content.clearcompany.com/js/v1/career-site.js?siteId={GUID}`).
The plugin currently has no way to take a siteId.

## Proposal

Accept a careers **siteId** in addition to the slug:

- `siteNumber` — the generic per-site identifier field already honoured by
  cornerstone/dayforce/oracle — carries the GUID when set. Highest precedence.
- A GUID-shaped `companySlug` also selects site mode (slugs are never GUIDs).
- A `?siteId=` query param on `companyUrl` (the embed-snippet shape) is a
  third resolution path.

When a siteId is resolved, fetch `careers-api/v1/{siteId}` and map its
camelCase `results` — a richer shape: structured `locations[]`
(city/subdivision/subdivisionFullName/country/postalCode/isRemote/
isNationwide), `applyLink`, `brandName`, `postedDate`, `departmentName`,
`jobFunctionName`. If the site feed errors (non-400/404) or returns empty and
a slug is also known, fall back to the legacy API-ShortName feed.

Slug-only input behaviour is unchanged.

## Non-goals

- Enumerating a tenant's siteIds (no public slug→siteId lookup was found; the
  caller supplies siteId).
- Switching slug callers over automatically — this adds a second input mode,
  not a migration.

## Contracts

- `GET {careers-api}/v1/{siteId}` → `{results: SiteJob[]}`; 400/404 → empty
  (same graceful handling as the legacy feed).
- `SiteJob` fields used: `id` (atsId), `positionTitle`, `description`,
  `postedDate`/`openDate`, `departmentName`/`jobFunctionName`, `locations[]`,
  `location`/`officeName`, `brandName`, `applyLink` (jobUrl = applyLink minus
  trailing `/apply`).
- `JobPostDto` mapping mirrors the slug path (id prefix `clearcompany-`,
  `atsType: 'clearcompany'`).

## Test plan

- GUID `companySlug` and `siteNumber` each hit `careers-api/v1/{id}`.
- `?siteId=` on `companyUrl` resolves site mode.
- Field mapping incl. multi-location `locations[]`, `jobFunctionName`
  department fallback, `postedDate`→`openDate` fallback.
- Empty site feed + known slug → slug-feed fallback.
- Slug-only input still hits the careers-page endpoint exactly once.
- Unknown siteId (404) → empty result, no error.
