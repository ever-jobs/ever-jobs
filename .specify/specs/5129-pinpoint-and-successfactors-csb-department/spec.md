# Spec: 5129 — Pinpoint nested department + SuccessFactors CSB department token

| Field | Value |
| --- | --- |
| Spec ID | 5129 |
| Slug | pinpoint-and-successfactors-csb-department |
| Status | implemented |
| Owner | agent |
| Created | 2026-09-16 |
| Related specs | 5090 |

## Problem

Two plugins drop department data the feed already carries, verified against live
boards:

- **Pinpoint** (verified: `impulsespace` — department present on all 191
  postings; `astrolab` — all 36). `postings.json` returns each posting with a
  nested `job.department = { id, name }` (e.g. `"Avionics"`,
  `"Assembly, Integration & Test"`). The adapter reads
  `attrs.department_name ?? attrs.department`, but the value lives at
  `job.department.name` — `JobPostDto.department` stays unset on every role.
- **SuccessFactors — CSB path** (verified on a `{companyId}.jobs.hr.cloud.sap`
  tenant). CSB detail pages render the requisition's department as a
  job-layout token: `<span data-careersite-propertyid="dept">Civil Structural
  Engineering</span>`. The CSB reader only extracts schema.org `JobPosting`
  microdata (`itemprop=...`), which has no department property — so
  `department` stays unset even when the page displays it. Tenants whose
  detail page lacks the token are unaffected (token absent → unset, same as
  today).

## Scope

- `packages/plugins/source-ats-pinpoint/src/pinpoint.service.ts` — resolve
  `department` from `attrs.job?.department?.name` (falling back to
  `listing.job?.department?.name` when the posting uses a JSON:API
  `attributes` wrapper), before the existing `department_name` /
  string-`department` fallbacks.
- `packages/plugins/source-ats-successfactors/src/successfactors.service.ts` —
  in `parseCsbDetail`, also read the first
  `[data-careersite-propertyid="dept"]` element's text into a new
  `SfCsbDetail.department`; `toCsbJobPost` maps it to
  `JobPostDto.department`.
- `packages/plugins/source-ats-successfactors/src/successfactors.types.ts` —
  add `department` to `SfCsbDetail`.

## Non-goals

- No change to the SuccessFactors OData path (its `department` select already
  exists), the tile-list reader, or any other plugin.
- No Oracle facet-based department mapping — the per-requisition feed carries
  no category id, and recovering it needs per-category queries (out of scope).
- No new `@ever-jobs/common` helper.

## Contracts

- Pinpoint: a posting whose `job.department.name` is a non-empty string emits
  it as `JobPostDto.department`; otherwise `department` falls through to the
  legacy flat keys, then stays unset. A `{ id, name }` object in a flat
  `department` key is never emitted (object ≠ string).
- SuccessFactors CSB: a detail page with a
  `data-careersite-propertyid="dept"` element emits its trimmed text as
  `department`; pages without the token keep `department` unset. Detail
  parsing still returns null when no recognizable content is present.

## Test plan

- **Pinpoint unit (mocked HTTP)** — `pinpoint.service.spec.ts`:
  - posting with `job.department = { id, name }` → `department === name`;
  - posting with no `job`/`department` → `department` unset (regression).
- **SuccessFactors CSB unit (fixture pages)** —
  `successfactors-csb.service.spec.ts`:
  - detail page carrying a `data-careersite-propertyid="dept"` span →
    `department` is its text;
  - detail page without the token → `department` unset (regression, existing
    fixtures already lack it).
