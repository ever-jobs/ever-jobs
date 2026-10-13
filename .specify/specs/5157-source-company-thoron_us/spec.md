# Spec: 5157

| Field | Value |
| ----- | ----- |
| Status | Done |
| Owner | ever-jobs maintainers |
| Plugin | `source-company-thoron_us` |
| Site | `Site.THORON_US = 'thoron_us'` |

## 1. Problem Statement

`thoron.us` (Thoron, drone systems) is a Vite-built SPA — the served
`/careers` HTML is a 1.6 KB shell whose `#root` is populated by a single
hashed bundle. The job board is a JS literal inside that bundle. Ever-jobs
has no plugin for the site.

## 2. Scope

- New source plugin `source-company-thoron_us` under
  `packages/plugins/source-company-thoron_us/`, registered in all four places.
- Two static GETs: the `/careers` shell → `/assets/index-{hash}.js` → the
  embedded jobs array. No headless.
- `companyDomains: ['thoron.us']` declared. `Site.THORON_US = 'thoron_us'`
  per Spec 5069 (dots → underscores).

## 3. Page Shape (verified live 2026-09-25)

- `thoron.us/careers` serves a Vite SPA shell; its only app script is
  `<script type="module" src="/assets/index-{hash}.js">`.
- The bundle carries `const <minified>=[{id,title,department,location,type,
  whatYoullDo[],whatYouBring[],niceToHaves[]}]` — **3 live entries**:
  Full-Stack Hardware Engineer, PCB Designer, Senior Mechanical Engineer –
  Electronics Packaging (all `Engineering`, `Seattle, WA`).
- Apply is an in-page modal POSTing FormData to `/api/job-applications`
  (name/email/phone/note/resume/jobTitle) — no per-role page or anchor;
  the site's fallback contact is `jobs@thoron.us`.
- Other arrays in the bundle share a `{icon:…,title:"…"}` shape but no
  `id`/`department` — the anchor must match the full job-entry field run.

## 4. Contract

Per entry:

- `id` / `atsId` = `thoron_us-{entry.id}` (native numeric ids).
- `title`; `department` = `department`; `location` → `parseLocationText`.
- `type` ("Full Time" / "Full or Part Time") → `jobType` +
  raw `employmentType`.
- `description` = composed from `whatYoullDo` / `whatYouBring` /
  `niceToHaves` sections with `- ` bullets.
- `jobUrl` / `jobUrlDirect` / `applyUrl` = `…/careers` — apply is a shared
  in-page form POST, no deep link exists.
- `site` = `Site.THORON_US`; `atsType` = `'thoron_us'`.

Filtering honors `resultsWanted` / `searchTerm` / `offset`. Zero entries →
`empty`; fetch failure → `classifyScrapeError`.

## 5. Non-Goals

- No `datePosted`, `compensation`, `workFromHomeType` — not published.
- No per-role URLs — roles open a modal on the careers page.
- No headless rendering — the data is in the bundle, not the DOM.
- `/api/job-applications` is a submit-only endpoint — not a listings feed.

## 6. Test Plan

Unit tests on live-fetched fixtures (shell + bundle):

- all 3 entries mapped with titles, department, Seattle location,
  Full-Time type;
- `id` = `thoron_us-{id}`; `jobUrl`/`applyUrl` = `/careers`;
- description composes the three sections;
- a distractor `[{id:…}]` array without the job shape does not parse;
- empty / error diagnostics; input filters.
