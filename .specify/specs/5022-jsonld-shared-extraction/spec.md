# Spec: 5022 — Shared schema.org JobPosting (JSON-LD) extraction

| Field | Value |
| --- | --- |
| Spec ID | 5022 |
| Slug | jsonld-shared-extraction |
| Status | implemented |
| Owner | agent |
| Created | 2026-06-24 |
| Last updated | 2026-06-24 |
| Related specs | 5015, 5018, 5019, 5020, 5021 |

## Problem

Several plugins need to read structured job data out of
`<script type="application/ld+json">` schema.org `JobPosting` blocks, but the
logic was either duplicated, private, or missing:

- **breezyhr** had a private `descriptionFromHtml()` that hand-rolled ld+json
  scanning to recover the description (its detail pages carry no JSON body).
- **paylocity** detail pages embed a rich `JobPosting` ld+json (clean `title`,
  `datePosted`, `hiringOrganization`, full `description`) but the plugin
  ignored it and scraped the `job-listing-header` HTML instead — brittle.
- There was **no generic harvester** for sites whose only structured source is
  a schema.org `JobPosting` (the last-resort case when no ATS is recognised).

schema.org `JobPosting` is a vendor-neutral **document standard**, not an ATS,
so the parsing belongs in `@ever-jobs/common` (like `resolveCompensation`,
`parseLocationText`, `extractEmails`) where every plugin can call it. Per the
plugin contract, no plugin imports another plugin — they all call common.

## Scope

1. **`parseJobPostingLd(html)` in `@ever-jobs/common`** — a pure parser that
   finds every ld+json block, parses defensively (malformed blocks skipped),
   unwraps the common container shapes (single object, array, `@graph`,
   `ItemList`/`ListItem`), accepts `@type` as a string or array, and normalises
   the fields into a flat `JobPostingLd[]`:
    - `title` (← `title` or `name`), `description`, `datePosted`,
      `validThrough`, `employmentType` (string or `, `-joined array),
      `hiringOrganizationName`, `hiringOrganizationUrl` (← `sameAs`/`url`),
      `url`, `applyUrl` (← `potentialAction` ApplyAction target), `remote`
      (← `jobLocationType === 'TELECOMMUTE'`), `locations[]`
      (city/region/country/postalCode + pre-joined `label`), `baseSalary`
      (min/max/currency/interval).
    - Companions: `extractLdJsonBlocks(html)` (raw blocks) and
      `jobPostingLdToCompensation(salary)` (→ `CompensationDto`).

2. **Refactor breezyhr** onto the shared helper — delete the private
   `descriptionFromHtml()` and the `BreezyJobPostingLd` type; pull the
   description from the first posting that has one. Behaviour unchanged.

3. **paylocity detail overlay — JSON-LD-first, HTML-fallback.** The board page
   spine (enumeration + location/remote/department from `window.pageData`)
   stays unchanged. The detail overlay now prefers the ld+json `description`
   (the real win) and **still parses the detail HTML for Job Type**, which the
   ld+json does not carry. Falls back to the HTML description when no ld+json.

4. **Generic `source-jsonld` plugin** (aggregator bucket — bare `source-*`,
   **not** `source-ats-*`, since JSON-LD is a document standard). Given a
   careers/job page URL (`companyUrl`), it fetches the HTML, parses every
   `JobPosting` via the shared helper, and emits one `JobPostDto` per posting.
   Applies the standard ATS checklist: structured-first→text-fallback
   compensation via `resolveCompensation`, multi-value/underscore-aware job
   type mapping, structured location, remote inference, description
   HTML/markdown/plain, `extractEmails`, `companyUrl`/`jobUrl`/`applyUrl`.
   Registered in the four required places (enum, plugins index, tsconfig, jest).

## Contracts

```ts
// @ever-jobs/common
export function parseJobPostingLd(html: string): JobPostingLd[];
export function extractLdJsonBlocks(html: string): unknown[];
export function jobPostingLdToCompensation(
  salary: JobPostingLdSalary | null | undefined,
): CompensationDto | null;

export interface JobPostingLd {
  title: string | null;
  description: string | null;
  datePosted: string | null;
  validThrough: string | null;
  employmentType: string | null;       // `, `-joined when an array
  hiringOrganizationName: string | null;
  hiringOrganizationUrl: string | null;
  url: string | null;
  applyUrl: string | null;
  remote: boolean;                      // jobLocationType === 'TELECOMMUTE'
  locations: JobPostingLdLocation[];
  baseSalary: JobPostingLdSalary | null;
}
```

## Payload shapes handled

- single `{ "@type": "JobPosting", ... }`
- array `[ {JobPosting}, {JobPosting} ]` in one block
- `{ "@graph": [ ... ] }` wrapper
- `{ "@type": "ItemList", itemListElement: [ {ListItem, item: JobPosting} ] }`
  (and the variant where the posting is inlined as the element)
- `@type` given as `"JobPosting"` or `["JobPosting", "Thing"]`
- malformed JSON inside a block → that block skipped, others still parsed

## Non-goals

- **Not** a detection-signal change — the detection-signal use of JSON-LD is
  tracked separately upstream.
- **Not** delegating paylocity wholesale to `source-jsonld` — paylocity's board
  page enumerates jobs and carries location/remote/department that the per-job
  ld+json lacks, so it cannot be replaced by a single-URL harvester.
- **Not** changing the paylocity board-page logic (Spec 5020 spine unchanged).
- breezyhr/paylocity do not call each other or `source-jsonld`; they call the
  shared common helper.

## Test plan

- `parseJobPostingLd`: single / array / `@graph` / `ItemList` shapes; malformed
  block skipped; missing fields; `@type` string vs array; `name`→`title`
  fallback; employmentType array join + remote detection; multi-location;
  min/max and single-value `baseSalary`; `applyUrl` from `potentialAction`.
- breezyhr: existing suite (detail-page ld+json) stays green on the shared
  helper.
- paylocity: existing suite stays green — description now sourced from ld+json,
  Job Type still from HTML, text-fallback compensation unaffected.
- `source-jsonld`: full posting → JobPostDto mapping; structured-salary
  preference; resultsWanted cap; remote-only posting; no-block / fetch-failure
  → empty result; url fallback to page URL.
- `npm run build` (tsc via nx) green; relevant jest suites green.
