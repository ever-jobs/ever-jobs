# Plan: 5134 — PulseSpace rendered-DOM scrape

| Field | Value |
| --- | --- |
| Spec ID | 5134 |
| Status | implemented |
| Created | 2026-09-19 |

## Phases

1. **`fetchJobs`** — `BrowserPool.getPage` once; render the careers list,
   collect deduped `/careers/<slug>` links, then render each detail page and
   parse it. Same single-page reuse pattern as other headless company
   plugins.
2. **`parseDetail`** — Cheerio over the rendered DOM: `main h1` title,
   following `p` subtitle, lucide-icon badge spans (map-pin/briefcase/
   building2 → location/type/department, positional fallback), `h2` sections
   → description.
3. Tests — rendered-HTML fixtures (list + one detail) via a `fetchHtml` mock;
   drop the old bundle fixtures.
4. Docs (`docs/index.md`, `docs/log.md`).

## Risks

- Lucide icon class names could change on redesign — mitigated by the
  positional badge fallback.
- `BrowserPool` adds a browser dependency where the old code was plain HTTP —
  accepted: the page is client-rendered, so no static-HTML path exists.
