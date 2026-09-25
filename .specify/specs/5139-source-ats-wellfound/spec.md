# Spec: 5139 — `source-ats-wellfound`: slug-keyed Wellfound company boards

| Field | Value |
| --- | --- |
| Spec ID | 5139 |
| Slug | source-ats-wellfound |
| Status | implemented |
| Owner | agent |
| Created | 2026-09-23 |

## Problem

Wellfound is primarily an aggregator — but some companies use it as
their *only* job board: `chipmotors.com/jobs` links out to
`wellfound.com/company/chipmotors/jobs`, and each posting's detail page
exists only on Wellfound. The existing `source-wellfound` plugin
(`Site.WELLFOUND`) is a search scraper — it takes `searchTerm`,
navigates `wellfound.com/jobs?q=…`, and parses whatever the aggregator
search returns. A query against it cannot guarantee complete coverage
of one company's board, and its input contract (`searchTerm`) does not
express "fetch every job this company posted."

## Contract

A new plugin `packages/plugins/source-ats-wellfound/`
(`Site.WELLFOUND_ATS = 'wellfound_ats'`, `category: 'ats'`,
`isAts: true`) that enumerates a company's full Wellfound board, keyed
by board identity rather than search query:

- Board address resolution, matching the `source-ats-*` convention:
  - `input.companyUrl` containing `/company/{slug}` (e.g.
    `https://wellfound.com/company/chipmotors/jobs`) → slug from path.
  - `input.companySlug` → `https://wellfound.com/company/{slug}/jobs`.
  - Neither resolvable → `JobResponseDto([], ScrapeDiagnostics('bad_input'))`.
- Fetching is headless — plain HTTP to wellfound.com is answered with a
  Cloudflare challenge (observed: 403 + "Just a moment…" page to
  datacenter IPs). The plugin uses `BrowserPool.getPage({stealth: true,
  proxy})` like `source-wellfound`.
- Data source: the SSR'd `#__NEXT_DATA__` JSON →
  `props.pageProps.apolloState.data`, a normalized Apollo cache in which
  every job is a `JobListing:{id}` node and the employer is a
  `Startup:{id}` node (shape verified against a live-archived board
  page). Listings nested under `data` are enumerated by `__typename`.
- Pagination: board pages take `?page=N` (page size ~20, per the
  `jobListingsConnection` `first:20` argument). The plugin iterates
  `?page=1,2,…`, collecting `JobListing` nodes it has not already seen
  (dedupe by `id`), and stops when a page yields no new listings —
  which also handles tenants where the parameter is ignored — or when
  `resultsWanted` is reached. A `totalPageCount` larger than the pages
  fetched logs a warning about possible truncation.
- A response page matching `looksLikeChallenge()` or lacking
  `__NEXT_DATA__` yields `ScrapeDiagnostics('blocked')` (or `empty`
  when a real page simply has no listings) — never a silent `ok`-looking
  zero.

## Field mapping (`JobListing` → `JobPostDto`)

| `JobListing` field | `JobPostDto` |
| --- | --- |
| `id` | `id = 'wellfound_ats-{id}'`, `atsId = String(id)` |
| `title` | `title` |
| `id` + `slug` | `jobUrl = https://wellfound.com/jobs/{id}-{slug}` |
| `startup.__ref` → `Startup:{id}.name` | `companyName` |
| `locationNames[]` | `location`/`locations` via `parseLocationList` |
| `remote` / `remoteConfig.kind` | `isRemote` (`remote` true, or remoteConfig kind containing "remote") |
| `primaryRoleParent` / `primaryRoleTitle` | `department` |
| `jobType` (`full_time`, …) | `jobType` via `getJobTypeFromString` |
| `liveStartAt` (epoch seconds) | `datePosted` |
| `compensation` (e.g. `"$120k – $200k"`) | `compensation` — parsed to min/max/yearly/USD; unparseable → null |
| `descriptionSnippet` (HTML) | `description`, honoring `descriptionFormat` |

`descriptionSnippet` is a snippet, not the full posting — the full body
lives on per-job detail pages, which this spec does not fetch
(non-goal). `site: Site.WELLFOUND_ATS` on every post.

## Non-goals

- No per-job detail-page fetch (doubles the page count through a bot
  wall; snippet + jobUrl carry the reader to ground truth).
- No GraphQL API calls — the SSR payload is sufficient for page 1 and
  `?page=N` URLs re-render server-side.
- No changes to `source-wellfound` (the aggregator search plugin keeps
  its own contract).
- No account/login flows; only public boards.

## Test plan

- Unit: slug/url resolution, Apollo-cache enumeration + dedupe across
  `?page=N`, field mapping (department, compensation string, remote,
  datePosted), `bad_input` on missing address, `blocked` on challenge
  HTML, `resultsWanted` cap.
- `BrowserPool.getPage` is stubbed in tests — no live Wellfound call.
