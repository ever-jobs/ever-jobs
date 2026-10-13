# Spec: 5167 — source-tesla browser fallback on Akamai challenge

| Field | Value |
| --- | --- |
| Spec ID | 5167 |
| Slug | tesla-browser-fallback |
| Status | draft |
| Owner | agent |
| Created | 2026-10-01 |
| Related specs | 013 (source-tesla, source-tesla-playwright) |

## Problem

`source-tesla` is HTTP-only: when the plain board GET
(`GET /cua-api/apps/careers/state`) fails — 403/503, an HTML body instead
of JSON, a network error, whatever the reason — `fetchBoard` returns
`null` and the plugin emits an empty `JobResponseDto`. The only escape
today is the optional `source-tesla-playwright` companion — a separate
`Site` token an operator must select explicitly. The default plugin never
recovers on its own: any host where the plain GET fails yields zero jobs
indefinitely.

## Proposal

Make the browser path a **fallback inside `source-tesla` itself**: when the
plain-HTTP board fetch fails (any reason), lazily `import('playwright')`, open
the careers-search landing page so the site's protection JS resolves and the
session acquires real browser cookies/TLS, then issue the same board +
detail `fetch()` calls **in-page** — browser-native credentials included.

Behaviour:

- HTTP succeeds → identical output to today (zero browser cost).
- HTTP fails + `playwright` installed → browser session:
  `goto careers-search (domcontentloaded, 60 s)` → 5 s settle → in-page
  `fetch(board)` polled up to 3× → in-page `fetch(detail)` per the
  `descriptionDepth` budget. Listings emit with `site: Site.TESLA`, so
  identity and dedup are unchanged whether the fast path or the fallback
  produced them.
- Headless first, headed once: observed live — headless gets edge
  "Access Denied" with 0 cookies; a headed window passes and the board
  JSON returns 200. If the headless attempt still cannot read the board,
  the plugin relaunches headed once — on a host without a display the
  headed launch throws instantly and the scrape degrades to the same
  empty DTO.
- HTTP fails + `playwright` NOT installed → warn sentinel
  `ERR_TESLA_BROWSER_UNAVAILABLE`, empty response (same as today).
- Navigation or browser-session failure → sentinel + empty response;
  `scrape()` still never throws.
- Default `descriptionDepth` moves `detail-25` → `board` (in
  `source-tesla` AND the companion). `detail-all` = one request per
  listing — ~8k+ sequential fetches, tens of minutes, likely trips
  per-IP request-rate limits partway — so "all" cannot be the default;
  `detail-25` yields an arbitrary partial set, worse than none.
  `'board'` = every listing, `description: null`; callers opt into
  `detail-all` explicitly.
- Docs/comments must describe only the observable ("the plain GET
  fails") — never presume *why* (flagged IP vs blanket rule vs outage).

## Scope

- `tesla.service.ts`: fallback branch + lazy playwright loader + in-page
  fetch helpers (mirroring the companion's flow; no peer-plugin imports).
- `tesla.constants.ts`: careers-page URL, launch args, timeouts, new
  sentinel constants.
- Tests: fallback wiring (HTTP-fail → browser used), unavailable browser,
  board-via-browser success emitting `Site.TESLA`.

## Non-goals

- Removing or changing `source-tesla-playwright` beyond its default
  depth flip — it stays unwired (not in `ALL_SOURCE_MODULES`, not
  importable by callers) and is documented as reference/sample code.
- Any change to `Site` registration or `ALL_SOURCE_MODULES`.
- Detail-fetch fan-out beyond the existing `descriptionDepth` budget.
