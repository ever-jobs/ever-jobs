# Spec: 5141 — `source-company-power_us`: Powerus careers board

| Field | Value |
| --- | --- |
| Spec ID | 5141 |
| Slug | source-company-power_us |
| Status | implemented |
| Owner | agent |
| Created | 2026-09-23 |

## Problem

`power.us` (Powerus, defense) self-hosts a careers page carrying 35
job blocks with no recognized ATS. A company plugin is needed.

## Contract

A new plugin `packages/plugins/source-company-power_us/`
(`Site.POWER_US = 'power_us'`, `category: 'company'`,
`companyDomains: ['power.us']`).

Site token is the Spec 5069 domain derivation: `power.us` → `.us` is
not `.com`, so it is kept; remaining dot → underscore → `power_us`.

### Data source (verified live)

`www.power.us/careers` is a static shell — the job list is fetched by
the page's JS from an **open JSON API**:

```
GET https://www.power.us/api/careers
→ 200, [{title, department, location, type, summary,
         responsibilities[], qualifications[], preferredSkills[],
         linkedInUrl}, ...]   // 35 entries
```

One anonymous fetch, no HTML parsing, no headless.

### Mapping

- `id`/`atsId`: `power_us-{linkedinJobId}` — the numeric id inside
  `linkedInUrl` (`linkedin.com/jobs/view/{id}`), stable and unique;
  falls back to slug-from-title when absent.
- `jobUrl`/`jobUrlDirect`: `linkedInUrl` — the only detail/apply link
  the company publishes (never fetched — LinkedIn is auth-gated).
- `department` → `department`; `location` → `parseLocationText`;
  `type` → `jobType` via `getJobTypeFromString` (all 35 "Full-time").
- `description` = summary + `Responsibilities:` + `Qualifications:` +
  `Preferred skills:` sections — emitted only when populated.
- `companyName`: `Powerus`.
- Diagnostics: empty array → `empty`; fetch failure →
  `classifyScrapeError`.

### Limitations (site-inherent)

- `summary`/`responsibilities`/`qualifications`/`preferredSkills` are
  **empty on all 35 entries today** — schema supports them, company
  has not populated. Plugin emits them when they appear.
- No `datePosted`, no `compensation` — not in the payload.
- Detail depth stops at title/dept/location/type — the real detail
  pages live on LinkedIn.

## Test Plan

Fixture JSON mirroring the live payload (multiple entries, one with
populated description fields):

- 35-entry fixture maps title/dept/location/jobType/jobUrl correctly.
- `power_us-{linkedinJobId}` id derivation; slug fallback.
- Description emitted when fields populated; absent otherwise.
- Empty array → `empty` diagnostic; fetch failure → diagnostics.
- `resultsWanted` cap.
