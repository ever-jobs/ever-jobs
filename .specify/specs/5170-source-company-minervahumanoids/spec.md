# Spec: 5170 — source-company-minervahumanoids

| Field | Value |
| --- | --- |
| Spec ID | 5170 |
| Slug | source-company-minervahumanoids |
| Status | draft |
| Owner | agent |
| Created | 2026-10-02 |

## Problem

Minerva Humanoids' careers page (`https://www.minervahumanoids.com/careers`)
renders role cards from a hand-rolled static CMS. The served HTML is a
mustache template (`{{ role.title }}` loops) — job data arrives via a plain
JS file, `GET {origin}/content/published.js`, which assigns
`window.__minervaContent = {…}` (strict JSON, 11 jobs verified live). No
source plugin covers it, so the board is invisible to callers.

## Scope

- New `source-company-minervahumanoids` plugin (`Site.MINERVAHUMANOIDS`,
  `companyDomains: ['minervahumanoids.com']`).
- Plain-HTTP scrape of `content/published.js`; one request, no browser.
- Strip the `window.__minervaContent=` assignment, `JSON.parse`, map every
  `content.jobs[]` entry to a `JobPostDto`.

## Non-goals

- The in-page apply form (`#apply` / `#talent-apply` anchors, with a
  `jobId` select) — `applyUrl` points at the anchor.
- Any other minervahumanoids.com surface (contact, mailto links).
- Rendered-DOM card counting — the JSON is the source of truth.

## Contracts

Request: `GET {origin}/content/published.js` where `{origin}` derives from
`input.companyUrl` (default `https://www.minervahumanoids.com`). Body is
JavaScript, not JSON: `window.__minervaContent={…}` — parse the `{…}` span
(first `{` to last `}`) with `JSON.parse`.

Job-entry shape (verified live):

```ts
content: {
  jobs: Array<{
    id: string;              // 'job-1' or uuid-suffixed 'job-1c8bf249-…'
    title: string;
    location: string;        // free text: 'San Francisco, USA' | 'Germany' | 'Open Application'
    published: boolean;      // visibility flag — gate on it
    applyUrl: string;        // empty today on every item
    program?: 'talent';      // present on the 4 intern-program roles
    blocks: Array<
      | { kind: 'paragraph' | 'heading'; text: string }
      | { kind: 'list'; items: string[] }
    >;
  }>;
}
```

Mapping:

- `id`/`atsId`: `minervahumanoids-{id}` / `{id}`.
- `jobUrl`/`jobUrlDirect`: `item.applyUrl` when non-empty, else
  `{origin}/careers#job-description-{id}` (the rendered role card's
  element id in the template).
- `applyUrl`: `item.applyUrl` when non-empty, else
  `{origin}/careers#apply` for regular roles and
  `{origin}/careers#talent-apply` for `program === 'talent'` roles.
- `location`: `parseLocationText(item.location)` → `LocationDto`
  (`San Francisco, USA` → city/country; `Germany` → country; non-geographic
  text → null).
- `description`: `blocks[]` flattened — `paragraph`/`heading` as text
  lines, `list.items` as `- ` bullets; blocks blank-line joined.
- `published === false` → dropped (gate; every item is `true` today).
- No `datePosted`/`department`/`employmentType`/`compensation` — absent
  from the data.
- `searchTerm`/`location`/`offset`/`resultsWanted` filtering mirrors the
  other company plugins.

## Test plan

- Unit (fixture = captured live `published.js`, 11 items):
  all items map; title/id/url fields; `#apply` vs `#talent-apply` apply
  anchors by `program`; non-empty `applyUrl` used verbatim; location text
  parsed; description flattens headings/lists; `published:false` dropped;
  searchTerm/location filters; empty/absent `jobs` → `empty` diagnostics;
  HTTP failure → `classifyScrapeError` diagnostics.
- `npm run tsc`, `npm run lint:docs` clean.
