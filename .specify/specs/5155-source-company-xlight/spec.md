# Spec: 5155

| Field | Value |
| ----- | ----- |
| Status | Done |
| Owner | ever-jobs maintainers |
| Plugin | `source-company-xlight` |
| Site | `Site.XLIGHT = 'xlight'` |

## 1. Problem Statement

`xlight.com` (xLight, free-electron lasers) lists openings at
`https://www.xlight.com/careers` — a Webflow CMS list where each card's
apply button links to a LinkedIn posting, not an ATS and not a per-role
page. Ever-jobs has no plugin for the site.

## 2. Scope

- New source plugin `source-company-xlight` under
  `packages/plugins/source-company-xlight/`, registered in all four places.
- One static GET of the careers page — the whole board is in the served
  HTML.
- `companyDomains: ['xlight.com']` declared.

## 3. Page Shape (verified live 2026-09-25)

- `/careers` is a ~70 KB server-rendered Webflow page.
- `div.careers-item.w-dyn-item` — 22 live cards. Each holds
  `h3.job-item-title`, a run of `div.job-item-info-label` divs forming a
  `|` -separated meta line (`Engineering | Full Time | Hybrid | Palo Alto`),
  and `a.job-item-btn` → `https://www.linkedin.com/jobs/view/{id}/`.
- Observed label order: department, employment type, work mode, location.
  Locations include `United States`, `Palo Alto`, `Albany, NY`,
  `San Francisco Bay Area`, `Newport News`; work modes `Remote`, `Hybrid`,
  `On-site`; types `Full Time`, `Part Time`.
- No descriptions, `datePosted`, `compensation`, or per-role pages on-site —
  details live on the linked LinkedIn postings.

## 4. Contract

Per card:

- `id` / `atsId` = `xlight-{linkedinId}` (the LinkedIn posting id is the
  only stable per-role key; slug-from-title fallback if a button ever
  lacks the `/jobs/view/{id}` href).
- `title` = `h3.job-item-title`.
- `department` = first label.
- `employmentType` + `jobType` = the middle label that is not a work mode
  (`extractJobType` on the de-hyphenated text for the enum; raw kept).
- `workFromHomeType` = `Remote` / `Hybrid` / `On Site` from the middle
  label matching `remote|hybrid|on-?site`.
- `location` = last label through `parseLocationText`.
- `jobUrl` = the careers page (no per-role pages on-site);
  `jobUrlDirect` / `applyUrl` = the LinkedIn posting URL.
- `site` = `Site.XLIGHT`; `atsType` = `'xlight'`.

Filtering honors `resultsWanted` / `searchTerm` / `location` / `offset`.
Zero cards → `empty`; fetch failure → `classifyScrapeError`.

## 5. Non-Goals

- No descriptions — on-site cards carry none; LinkedIn postings are not
  followed.
- No `datePosted`, `compensation` — not published.
- No headless rendering — one static GET.

## 6. Test Plan

Unit tests on a live-fetched fixture (careers page):

- all 22 cards mapped;
- per-card department / type / work mode / location parsed from the label
  line;
- `id` = `xlight-{linkedinId}`; `jobUrl` = careers page,
  `applyUrl`/`jobUrlDirect` = the LinkedIn link;
- a malformed href falls back to the title slug for `atsId`;
- empty / error diagnostics; input filters.
