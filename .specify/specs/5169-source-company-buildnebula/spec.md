# Spec: 5169 — source-company-buildnebula

| Field | Value |
| --- | --- |
| Spec ID | 5169 |
| Slug | source-company-buildnebula |
| Status | draft |
| Owner | agent |
| Created | 2026-10-03 |

## Problem

Nebula's careers page (`https://buildnebula.com/careers`) is a Vite SPA shell —
the served HTML contains no job data. The SPA fetches a first-party JSON
endpoint, `GET {origin}/api/careers/listings`, which returns the complete job
dataset inline (`{items: [...]}` — 16 items verified live). No source plugin
covers it, so the board is invisible to callers.

## Scope

- New `source-company-buildnebula` plugin (`Site.BUILDNEBULA`,
  `companyDomains: ['buildnebula.com']`).
- Plain-HTTP scrape of `/api/careers/listings`; one request, no browser.
- Map every `items[]` entry to a `JobPostDto`.

## Non-goals

- The apply form flow (`apply_form_key: "careers-application"` posts to a
  site-internal submit endpoint) — `applyUrl` points at the listing page.
- The per-slug detail endpoint (`/api/careers/listings/{slug}` → 410/404 on
  dead roles) — the list response already carries full detail.
- Any other buildnebula.com API surface (orders, auth, analytics).

## Contracts

Request: `GET {origin}/api/careers/listings` where `{origin}` derives from
`input.companyUrl` (default `https://buildnebula.com`). Response:
`{items: Listing[]}`.

Listing shape (verified live):

```ts
{
  listing_id: string;            // uuid
  slug: string;                  // e.g. 'data-platform-engineer'
  status: 'published' | ...;
  takedown: boolean;
  visibility: 'public' | ...;
  published_at: string;          // ISO-8601
  compensation_line?: string;    // '$100k to $250k base salary, plus equity'
  equity_sentence?: string;
  job: {
    title: string;
    team?: string;               // materials|cybernetics|production|business_operations
    track?: string | null;
    department?: string;         // 'Engineering & Information Technology'
    employment_type?: string;    // 'full_time'
    locations?: { city?: string; state?: string; country?: string;
                  workplace_type?: string }[];
    compensation?: { min?: number; max?: number; currency?: string;
                     period?: string };
    description_sections?: { prose?: string; responsibilities?: string[];
                             requirements?: string[]; nice_to_have?: string[] };
    closing_paragraphs?: string[];
    benefits?: string[];
  };
}
```

Mapping:

- `id`/`atsId`: `buildnebula-{slug}` / `{slug}`.
- `jobUrl`/`jobUrlDirect`/`applyUrl`: `{origin}/careers/{slug}`.
- `department`: `job.department`; `team`: `job.team` labelized
  (`cybernetics`→`Cybernetics`, `materials`→`Materials`, `production`→`Production`,
  `business_operations`→`Business & Operations`, else title-case the token).
- `locations[]`: one `LocationDto` per entry (`city`/`state`/`country`
  verbatim); `location` = the first entry. `isRemote` only when
  `workplace_type === 'remote'`.
- `employmentType`: raw `employment_type` (`full_time`);
  `jobType`: `getJobTypeFromString`.
- `compensation`: `CompensationDto{minAmount,maxAmount,currency,interval}`
  via `getCompensationInterval(period)`.
- `datePosted`: `published_at`.
- `description`: `prose` + bulleted `responsibilities`/`requirements`/
  `nice_to_have` (SPA headings: "What to Expect", "What You'll Do",
  "What You'll Bring", "Nice to Have") + `closing_paragraphs` + `benefits`
  + `compensation_line` + `equity_sentence`, blank-line joined.
- Filtering: only `status === 'published'`, `takedown !== true`,
  `visibility === 'public'` when those fields are present.
- `searchTerm`/`location`/`offset`/`resultsWanted` filtering mirrors the
  other company plugins.

## Test plan

- Unit (fixture = captured live listings payload, 16 items):
  all items map; title/id/url/slug fields; department + team label;
  location → city/state; compensation → CompensationDto; description
  contains prose + section headings + comp line; unpublished/takedown
  items dropped; searchTerm/location filters; empty `items` → `empty`
  diagnostics; HTTP failure → `classifyScrapeError` diagnostics.
- `npm run tsc`, `npm run lint:docs` clean.
