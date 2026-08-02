# Spec: 5043 — source-ats-submit4jobs

| Field | Value |
| --- | --- |
| Spec ID | 5043 |
| Slug | source-ats-submit4jobs |
| Status | implemented |
| Plugin | `packages/plugins/source-ats-submit4jobs` |
| Related specs | 5038 (icims server-rendered board), 5039 (isolved board JSON API), 5040 (jobvite board + detail), 5041 (prismhr board + detail) |

## Problem

There was no adapter for **Submit4Jobs** careers boards (the white-label
careers product from Pereless Systems). Tenants publish public boards at
`https://{slug}.submit4jobs.com/`, and none were being ingested.

Each board is a ColdFusion-hosted Angular SPA embedded via an iframe. The page
does not server-render the job list — the SPA calls a JSON API. Two facts make
a headless browser unnecessary:

- The tenant board home page (`https://{slug}.submit4jobs.com/`) embeds a
  `<script>` whose `src` reveals the API host, template, and company id (`cid`):
  `//{apiHost}/templates/{template}/embed/iframe.cfm?cid={cid}`. Observed
  hosts/templates: `apps.submit4jobs.com`/`magneto` and
  `devapps.pereless.com`/`magnetolive`.
- The list endpoint `POST /templates/{template}/api/?action=getJobs` (header
  `cid`, JSON body `{filters:{…}}`) returns the full job array — but only once a
  ColdFusion session exists. Fetching the embed iframe first
  (`GET .../embed/iframe.cfm?cid={cid}`) sets the CF session cookies
  (`CFID`, `CFTOKEN`, `CFCLIENT_CAREERHOSTING` bound to the `cid`); replaying
  those three cookies on the `getJobs` POST returns the jobs. No browser needed.

## Scope

New plugin `source-ats-submit4jobs` that discovers the API coordinates from the
board page, primes a CF session over plain HTTP, enumerates via `getJobs`, then
fills the description (only where the list omits it) from a per-job detail call:

```
GET https://{slug}.submit4jobs.com/
  → parse embed <script src> → { apiHost, template, cid }

GET https://{apiHost}/templates/{template}/embed/iframe.cfm?cid={cid}
  → capture Set-Cookie: CFID, CFTOKEN, CFCLIENT_CAREERHOSTING

POST https://{apiHost}/templates/{template}/api/?action=getJobs
  headers: { cid, Cookie }
  body:    { filters: <template-default filters> }
  → JSON array of job objects (title, location, dept, dates, salary, body)

POST …?action=getJobs  { filters: { jid, … } }   (bounded fan-out; only when
  the list row's jobdescription is empty — the magnetolive template omits it)
  → single job object with jobdescription + reqsexp
```

### Field mapping

| JobPostDto field | Source |
| --- | --- |
| `atsId` | list `jid` (numeric job id) |
| `id` | `submit4jobs-{slug}-{jid}` |
| `title` | list `job_title` |
| `jobUrl` / `applyUrl` | `https://{slug}.submit4jobs.com/#/jobDescription/{jid}/{title-slug}` |
| `companyName` | list `companyname`, de-slugified tenant token fallback |
| `department` | list `dname` (department display name) |
| `location` | list `city`, `state`, `fullCountryName` → `parseLocationList` |
| `isRemote` | `parseLocationList` remote signal from the composed location/title text |
| `employmentType` | list `jobtype` (e.g. `Full-Time/Regular`) |
| `datePosted` | list `postingdate` (`"March, 26 2026 14:27:04"` → `YYYY-MM-DD`) |
| `description` | list `jobdescription` + `reqsexp`; detail call when the list omits it |
| `compensation` | list `salary` / `salaryrange` (min/max) + `salarytype` (`H`→hourly, `Y`→yearly) + `jobcurrency` |
| `emails` | extracted from the description body |

### Non-goals

- No headless browser. Cookie priming + JSON API is sufficient; the SPA is not
  driven.
- No filter/search passthrough: the plugin always requests the full open-role
  list (template-default empty filters), then applies `resultsWanted` locally.
- `employmentType` is passed through verbatim from `jobtype`; not normalised into
  `JobType[]`.
- Detail fan-out is issued only for rows whose `jobdescription` is empty (the
  `magnetolive` template), avoiding N+1 for templates that inline the body.

## Contracts

### Tenant resolution

- `companySlug` = the board subdomain (e.g. `ams`), or a full
  `{slug}.submit4jobs.com` URL.
- `companyUrl` = any `https://{slug}.submit4jobs.com/...` URL — the subdomain is
  the slug.

### API discovery

```
GET https://{slug}.submit4jobs.com/
  ↳ <script src="//{apiHost}/templates/{template}/embed/iframe.cfm?cid={cid}">
      apiHost   ∈ { apps.submit4jobs.com, devapps.pereless.com, … }
      template  ∈ { magneto, magnetolive, … }
      cid       = numeric company id
```

- The embed host/template/cid are read from the page, never hard-coded per
  tenant, so a tenant on any Pereless host/template resolves automatically.

### Session priming

- `GET https://{apiHost}/templates/{template}/embed/iframe.cfm?cid={cid}` sets
  the CF session cookies. The plugin forwards only `CFID`, `CFTOKEN`, and
  `CFCLIENT_CAREERHOSTING` (the last carries `cid={cid}`) on the `getJobs` POST.
- Cookie deletion entries (`Expires` in the past) are skipped.

### Enumeration

- `POST …/api/?action=getJobs` with header `cid` and body
  `{filters: <template default>}`.
  - `magneto` default filters: `{buid, intranet, city, state, country, title,
    zipcode, department, businessname, language}` (empty strings).
  - `magnetolive` default filters: `{buid, intranet, city, mystate:[], country,
    title, zipcode, department, businessname, jobtype, keyword,
    jobcapability:[], jobcategory:[]}`.
- Response is a JSON array of job objects; de-duped by `jid`, capped at
  `resultsWanted`.

### Detail parse (conditional)

- When a list row's `jobdescription` is empty, re-issue `getJobs` with
  `filters.jid = jid` (template-default filters otherwise) → the single job
  carries `jobdescription` + `reqsexp`.
- Bounded fan-out (`Promise.allSettled`, concurrency cap); a failed detail leaves
  the role with a null description rather than dropping it.

### Graceful degradation

- No slug/url → `[]` (no HTTP issued).
- Board page missing / embed script absent → `[]`.
- `getJobs` returning the Pereless error HTML instead of JSON → `[]`.

## Test plan

### Unit tests (mocked HTTP)

- Embed-script discovery for both host/template pairs
  (`apps.submit4jobs.com`/`magneto`, `devapps.pereless.com`/`magnetolive`).
- Session cookies primed from the iframe response and replayed on `getJobs`
  (Cookie header carries `CFID`/`CFTOKEN`/`CFCLIENT_CAREERHOSTING`;
  deletion cookies dropped).
- List → normalised job (all fields) for a `magneto` tenant with inline body.
- `magnetolive` tenant: list omits `jobdescription` → detail call fills it.
- Detail fan-out only for rows with empty `jobdescription`.
- Location built from `city`/`state`/`fullCountryName`.
- Compensation: `salarytype` `H` → hourly, `Y` → yearly; numeric min/max parsed
  from strings like `"52,000"` / `"55,000"`; null when salary is empty.
- `datePosted` parsed from `"March, 26 2026 14:27:04"` → `YYYY-MM-DD`.
- De-dupe a job listed twice; `resultsWanted` cap.
- No slug/url → `[]` (no HTTP).
- Slug resolved from a `companyUrl`.
- `getJobs` returning error HTML → `[]`.
- Description formatting (HTML / Markdown / plain); email extraction from body.

### Live validation

- 3 live public boards across both templates.
- Independent probe (same discovery → prime → getJobs) vs plugin output.
