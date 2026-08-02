# Spec: 5040 — jobvite-board-jsonld

| Field | Value |
| --- | --- |
| Spec ID | 5040 |
| Slug | jobvite-board-jsonld |
| Status | implemented |
| Plugin | `packages/plugins/source-ats-jobvite` |
| Related specs | 5022 (shared JSON-LD extraction), 5038 (icims server-rendered board) |

## Problem

`source-ats-jobvite` returned **0 jobs for every tenant tested**. It called a
private feed endpoint (`/api/v2/job-feed/{slug}`) that no longer exists — every
request 3xx-redirects to a Jobvite support page, so the plugin produced nothing.

Modern Jobvite career boards live at `https://jobs.jobvite.com/{slug}/` and are
rendered by a client-side Angular SPA. There is no public JSON feed, but Jobvite
serves **fully server-rendered HTML** for the two views a scraper needs:

- `GET /{slug}/jobs` — the job list, grouped under `<h3 class="h2">{department}</h3>`
  headings, each followed by a `table.jv-job-list` of role rows.
- `GET /{slug}/job/{jobId}` — the role detail page, embedding a schema.org
  `JobPosting` JSON-LD block with the full description, date, employment type,
  structured location, remote flag, and (when present) compensation.

## Scope

Rewrite the plugin onto the server-rendered board + detail JSON-LD (a hybrid, in
the vein of Spec 5038 and 5039):

```
GET /{slug}/jobs
  → parse each <h3> department heading + following table.jv-job-list rows
  → per row: title, /job/{jobId} URL, department, location cell text

GET /{slug}/job/{jobId}   (bounded fan-out, one per role)
  → parseJobPostingLd(html)[0]  (shared extractor, Spec 5022)
  → description, datePosted, employmentType, structured location,
    jobLocationType → remote, baseSalary → compensation, hiringOrganization
```

### Field mapping

| JobPostDto field | Source |
| --- | --- |
| `atsId` / `id` | the `/job/{jobId}` path token |
| `title` | list row anchor text |
| `jobUrl` / `applyUrl` | `https://jobs.jobvite.com/{slug}/job/{jobId}` |
| `companyName` | detail JSON-LD `hiringOrganization`, board `<title>` fallback |
| `department` | the `<h3>` heading the row is grouped under |
| `location` | detail JSON-LD `jobLocation[].address`, list cell text fallback |
| `isRemote` | JSON-LD `jobLocationType === 'TELECOMMUTE'`, text heuristic fallback |
| `employmentType` | JSON-LD `employmentType` |
| `datePosted` | JSON-LD `datePosted` (ISO → `YYYY-MM-DD`) |
| `description` | JSON-LD `description` (HTML body, formatted per `descriptionFormat`) |
| `compensation` | JSON-LD `baseSalary` via `jobPostingLdToCompensation` |
| `emails` | extracted from the description body |

### Non-goals

- No headless browser. The board's two views are server-rendered; the SPA is not
  required.
- No authenticated / private feed path (the old `/api/v2/job-feed/` endpoint is
  dead and is removed, not retained as a fallback).
- No pagination: the `/{slug}/jobs` view renders all open roles on one page
  (capped at `resultsWanted`).

## Contracts

### Tenant resolution

- `companySlug` = the board slug (e.g. `acme-corp`), or a full
  `jobs.jobvite.com/{slug}` URL.
- `companyUrl` = any `jobs.jobvite.com/{slug}/...` URL — the first path segment
  is the slug.

### Board parse

```
table.jv-job-list                    → one per department group
  ↳ preceding <h3 class="h2">         → department
  ↳ tbody tr                          → a role row
      td.jv-job-list-name a[href]     → title + /job/{jobId}
      td.jv-job-list-location         → location cell text
```

- Rows are de-duped by `jobId` (a role listed under two headings keeps the first
  department seen).

### Detail parse

- Uses the shared `parseJobPostingLd` extractor (Spec 5022); the first
  `JobPosting` node supplies description, date, employment type, structured
  location, remote flag, and compensation.

### Graceful degradation

- A board that 3xx-redirects away (tenant migrated off Jobvite) → `[]`.
- A missing/failed detail page → the role is still emitted from list fields,
  with detail-only fields null.
- Per-role detail fan-out is bounded (`Promise.allSettled`, concurrency cap) so
  one slow/failed page never nukes the batch.

## Test plan

### Unit tests (mocked HTTP)

- Grouped board + detail JSON-LD → normalised job (all fields).
- Department assigned from the nearest preceding heading.
- `isRemote` from `TELECOMMUTE`; text fallback when detail is missing.
- Structured compensation from `baseSalary`; null when absent/empty.
- De-dupe a role listed under two departments.
- `resultsWanted` cap.
- Board redirect (moved-off tenant) → `[]`.
- No slug/url → `[]` (no HTTP issued).
- Slug resolved from a `companyUrl`.
- Description formatting (HTML / Markdown / plain).
- Email extraction from the body.
- `hiringOrganization` as companyName, board title fallback.

### Live validation

- 4 live public boards (37 / 16 / 9 / 19 = 81 roles).
- Independent probe (same server-rendered list + JSON-LD detail) vs plugin output.
- Result: 0 field diffs across all 81 sampled roles.
- A 5th board in the sample set had migrated off Jobvite (board redirects away);
  the plugin correctly returns `[]` for it.
