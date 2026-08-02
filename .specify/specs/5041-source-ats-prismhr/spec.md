# Spec: 5041 — source-ats-prismhr

| Field | Value |
| --- | --- |
| Spec ID | 5041 |
| Slug | source-ats-prismhr |
| Status | implemented |
| Plugin | `packages/plugins/source-ats-prismhr` |
| Related specs | 5022 (shared JSON-LD extraction), 5038 (icims server-rendered board), 5040 (jobvite board + detail JSON-LD) |

## Problem

There was no adapter for **PrismHR** careers boards (the applicant-tracking
product powered by HiringThing). PrismHR tenants publish public boards at
`https://{slug}.prismhr-hire.com/`, and none were being ingested.

An existing `source-ats-hiringthing` adapter targets the same underlying
platform but is not usable for scraping third-party tenants: it calls the
authenticated owner-side REST API (`api.hiringthing.com`, Basic Auth with an
account's private API key), so it returns only that one account's jobs and
yields nothing without a key we cannot obtain for arbitrary companies. This
adapter instead scrapes the anonymous public board — no credentials, addressable
by slug/URL for any tenant — and additionally populates fields the owner-API
path leaves empty here (structured location, isRemote, real min/max
compensation). The two are complementary, not duplicates; the hiringthing
adapter is left untouched.

The board is a React SPA, but the server renders enough HTML for a scraper to
avoid a headless browser entirely. Two views carry everything needed:

- `GET /` — the board list page. A `data-react-props` JSON payload on the
  `HiringThing.Components.JobFiltersContainer` element enumerates every open
  role: a `titles[]` array (`{id, title}`), a `locations` map
  (`state → city → [ids]`), a `categories` map (`category → [ids]`), and a
  `remotePositions[]` id list.
- `GET /job/{id}` — the role detail page. It embeds both a schema.org
  `JobPosting` JSON-LD block (description, datePosted, hiringOrganization,
  structured location) and a `HiringThing.Components.ApplyButtonGroup`
  `data-react-props` JSON carrying the remote flag, salary (`min_salary`,
  `max_salary`), `pay_frequency`, and category.

## Scope

New plugin `source-ats-prismhr` that reads the board list for enumeration, then
fans out to each detail page for description/date/salary enrichment (a hybrid,
in the vein of Spec 5038, 5039, and 5040):

```
GET /
  → parse data-react-props on JobFiltersContainer
  → per job: id, title, (city, state) from locations map,
    isRemote from remotePositions, department from categories map

GET /job/{id}   (bounded fan-out, one per role)
  → parseJobPostingLd(html)[0]  (shared extractor, Spec 5022)
    → description, datePosted, employmentType, structured location,
      hiringOrganization
  → data-react-props on ApplyButtonGroup (jobObj.table)
    → remote, min_salary / max_salary / pay_frequency → compensation, category
```

### Field mapping

| JobPostDto field | Source |
| --- | --- |
| `atsId` | board `titles[].id` (numeric job id) |
| `id` | `prismhr-{slug}-{id}` |
| `title` | board `titles[].title` |
| `jobUrl` / `applyUrl` | `https://{slug}.prismhr-hire.com/job/{id}` |
| `companyName` | detail JSON-LD `hiringOrganization` / react-props `company_name`, board `<title>` fallback |
| `department` | detail react-props `category`, board `categories` map fallback |
| `location` | detail JSON-LD `jobLocation` / react-props `location_info`, board `locations` map fallback |
| `isRemote` | detail react-props `remote` OR board `remotePositions`, title/location text fallback |
| `employmentType` | detail JSON-LD `employmentType` (usually absent on PrismHR) |
| `datePosted` | detail JSON-LD `datePosted` / react-props `posted_at` (ISO → `YYYY-MM-DD`) |
| `description` | detail JSON-LD `description` (HTML body, formatted per `descriptionFormat`) |
| `compensation` | detail react-props `min_salary` / `max_salary` + `pay_frequency` |
| `emails` | extracted from the description body |

### Non-goals

- No headless browser. Both views are server-rendered; the SPA is not required.
- No pagination: the board list renders all open roles in one payload (capped at
  `resultsWanted`).
- `employmentType` is best-effort — PrismHR JSON-LD rarely carries it, so it is
  usually null; not synthesized from heuristics.

## Contracts

### Tenant resolution

- `companySlug` = the board subdomain (e.g. `realta-fusion-inc`), or a full
  `{slug}.prismhr-hire.com` URL.
- `companyUrl` = any `https://{slug}.prismhr-hire.com/...` URL — the subdomain is
  the slug.

### Board parse

```
[data-react-class="HiringThing.Components.JobFiltersContainer"]
  ↳ data-react-props (JSON)
      titles[]          → {id, title} for every role
      locations{}       → state → city → [ids]  (inverted to id → city/state)
      categories{}      → category → [ids]      (inverted to id → category)
      remotePositions[] → ids flagged remote
```

- Jobs are de-duped by `id` (first occurrence wins).
- Company name from the `<title>` ("{Company} Career Opportunities"),
  `og:title` fallback, then a de-slugified tenant token.

### Detail parse

- Shared `parseJobPostingLd` extractor (Spec 5022) supplies description, date,
  employmentType, hiringOrganization, and structured location.
- The `ApplyButtonGroup` react-props (`jobObj.table`) supplies remote,
  salary (min/max amount + currency), `pay_frequency`, and category.

### Graceful degradation

- A board that is unreachable / 4xx (tenant migrated off PrismHR) → `[]`.
- A missing/failed detail page → the role is still emitted from board fields,
  with detail-only fields null.
- Per-role detail fan-out is bounded (`Promise.allSettled`, concurrency cap) so
  one slow/failed page never nukes the batch.

## Test plan

### Unit tests (mocked HTTP)

- Board react-props + detail JSON-LD → normalised job (all fields).
- Enumerate every role from the `titles[]` array.
- Location from the board `locations` map when detail lacks it.
- `isRemote` from `remotePositions`; from detail react-props `remote`; text
  fallback when both are silent.
- Department from the board `categories` map; detail react-props `category`
  takes precedence.
- Structured compensation from react-props salary + `pay_frequency` (yearly and
  hourly); null when salary objects are empty.
- De-dupe a role listed twice in `titles[]`.
- `resultsWanted` cap.
- Unreachable board (moved-off tenant) → `[]`.
- No slug/url → `[]` (no HTTP issued).
- Slug resolved from a `companyUrl`.
- Description formatting (HTML / Markdown / plain).
- Email extraction from the body.
- `hiringOrganization` as companyName, board title fallback.
- Job with JSON-LD only (react-props absent) still emitted with description.

### Live validation

- 5 live public boards (15 / 1 / 6 / 6 / 1 = 29 roles).
- Independent probe (same board react-props + detail JSON-LD / react-props) vs
  plugin output.
- Result: 0 field diffs across all 29 sampled roles.
