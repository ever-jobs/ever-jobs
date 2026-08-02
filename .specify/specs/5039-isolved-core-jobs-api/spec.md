# Spec: 5039 — isolved-core-jobs-api

| Field | Value |
| --- | --- |
| Spec ID | 5039 |
| Slug | isolved-core-jobs-api |
| Status | implemented |
| Plugin | `packages/plugins/source-ats-isolved` |
| Related specs | 5030, 5032 (structured compensation precedents) |

## Problem

`source-ats-isolved` returns correct job counts (verified against 5 live tenants)
but leaves three field families unpopulated:

- **department** — hardcoded `null` (line 412). The board's own JSON API exposes
  `classification` and `orgTitle` per job (e.g. "Engineering", "Finance").
- **compensation** — not set at all. The API exposes `minSalary`, `maxSalary`,
  `payType`, and `payTypeFrame` per job (e.g. "130,000.00"–"160,000.00 per year").
- **isRemote** — text-heuristic only (regex on title/location/employmentType).
  The API exposes a structured `workplaceType` field ("Onsite", "Remote",
  "Work from home flexibility", "Hybrid") which the text heuristic misses when
  the title and location are physical.

The current plugin fetches the XML sitemap (`/job_site_map.xml`) then fans out to
N detail pages (`/jobs/{id}.html`) for JSON-LD — an N+1 pattern. The board's own
Vue SPA calls a single JSON endpoint that returns ALL open roles with structured
fields in one request.

## Scope

Rewrite the enumeration path onto the board's real JSON API:

```
GET https://{tenant}.isolvedhire.com/jobs/
  → parse domainId from componentData in the HTML shell

GET https://{tenant}.isolvedhire.com/core/jobs/{domainId}?getParams={json}
  → { data: { jobs: IsolvedApiJob[], jobCount: number } }
```

Then fan out to detail pages (`/jobs/{id}.html`) for the full description body
(the list API omits it). This is a hybrid: list API for structured fields,
detail JSON-LD for description — same N+1 cost as today, strictly richer data.

### Field mapping (list API → JobPostDto)

| JobPostDto field | Source |
| --- | --- |
| `atsId` / `id` | `job.id` (numeric) |
| `title` | `job.title` |
| `jobUrl` / `applyUrl` | `https://{tenant}.isolvedhire.com/jobs/{id}.html` |
| `companyName` | board HTML `domainTitle` or JSON-LD `hiringOrganization.name` |
| `location` | `city`, `abbreviation` (state), `iso3` → 2-letter country |
| `department` | `classification` or `orgTitle` (first non-null) |
| `compensation` | `minSalary`/`maxSalary` parsed, `payTypeFrame` → interval |
| `isRemote` | `workplaceType` contains "remote" or "work from home" (case-insensitive) |
| `employmentType` | `employmentType` (already title-cased in API) |
| `datePosted` | detail JSON-LD `datePosted` (ISO, reliable) |
| `description` | detail JSON-LD `description` (HTML body) |

### Non-goals

- Dropping the detail-page fetch for description (user explicitly chose hybrid).
- Paginating the list API (returns all jobs in one call; cap at `resultsWanted`).
- Removing the XML sitemap code path entirely (removed — API is the new primary;
  no fallback).

## Contracts

### Tenant resolution (unchanged)

- `companySlug` = bare subdomain (`electra`) or a full `*.isolvedhire.com` URL.
- `companyUrl` = any URL on an `isolvedhire.com` host.

### Board metadata extraction

```
GET /jobs/ → HTML
  → regex domainId\s*:\s*(\d+) from componentData block
  → regex domainTitle\s*:\s*"([^"]+)" from social-widget componentData
```

### Core jobs API request

```
GET /core/jobs/{domainId}?getParams={"isInternal":0}
  → 200 { success: true, data: { jobs: [...], jobCount: N } }
```

### Compensation parsing

- `minSalary` / `maxSalary`: strip commas, `parseFloat`.
- `payTypeFrame`: extract unit word ("per year" → "year"), map via
  `getCompensationInterval`.
- Null when both min and max are empty/zero.

### isRemote mapping

- `workplaceType` matching `/remote|work.from.home/i` → `true`.
- Falls back to the existing title/location text heuristic for roles where
  `workplaceType` is absent.

### Country code normalisation

- API `iso3` (e.g. "USA") → 2-letter ISO 3166-1 alpha-2 (e.g. "US") via a
  small lookup for common codes. Pass through unknown codes as-is.

## Test plan

### Unit tests (mocked HTTP)

- Board metadata extraction (domainId + companyName from HTML)
- Core jobs API parse → IsolvedApiJob[]
- Single-job mapping → all JobPostDto fields (department, comp, remote, location)
- Detail fetch integration (JSON-LD description merged with API fields)
- resultsWanted cap
- workplaceType → isRemote mapping (Onsite=false, Remote=true, WFH=true)
- Compensation parsing (min/max/interval, empty → null)
- Unknown tenant → [] (graceful degradation)
- Missing domainId → [] (graceful degradation)

### Live validation

- 5 tenants (electra, seegrid, integertech, northerngear, cardmonroeautomation).
- Independent probe (same API) vs plugin output.
- Result: 0 field diffs across all 73 sampled jobs (38/14/9/7/5).
