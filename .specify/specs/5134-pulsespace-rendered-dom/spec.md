# Spec: 5134 — PulseSpace rendered-DOM scrape

| Field | Value |
| --- | --- |
| Spec ID | 5134 |
| Slug | pulsespace-rendered-dom |
| Status | implemented |
| Owner | agent |
| Created | 2026-09-19 |

## Problem

`source-company-pulsespace` scraped the careers page's JS bundle for a
`const wve={…}` job-map literal. The site was rebuilt: `wve` is now a React
component name and role data lives in unrelated minified consts, so the
plugin parsed nothing and returned 0 jobs (verified live).

## Contract

- Render `https://pulsespace.com/careers` via `BrowserPool` (the careers page
  is a client-rendered SPA; the raw HTML shell has no job content).
- Roles = rendered `a[href*="/careers/<slug>"]` links on the list page.
- For each `/careers/<slug>` detail page (rendered):
  - `main h1` → title; the `p` following it → subtitle (description lead).
  - Badge `span`s (svg icon + text): `lucide-map-pin` → location,
    `lucide-briefcase` → job type, `lucide-building2` → department; missing
    icons fall back to badge order.
  - Each `main h2` heads a section; the sibling container's `p`/`li` items
    become the description (`## heading` + items).
- `id = pulsespace-<slug>`; `jobUrl`/`jobUrlDirect` = the detail URL (the
  page exposes no separate apply link).
- `resultsWanted`/`offset`/`searchTerm`/`location`/`isRemote`/`jobType`
  filters unchanged.

## Verified live

- `pulsespace.com/careers` rendered: 1 role
  (`principal-controls-engineering-architect`); scrape returned 1 job with
  title, Seattle WA location, `Engineering / Controls` department, and a
  ~4.3 KB description.

## Non-goals

- No posted date — the rendered page carries none.
- No apply URL — the detail page exposes no application link.
