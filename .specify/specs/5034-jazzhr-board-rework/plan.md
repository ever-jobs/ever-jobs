# Plan: 5034 — JazzHR board rework

| Field | Value |
| --- | --- |
| Spec ID | 5034 |
| Status | implemented |
| Created | 2026-06-28 |

## Packages touched

- `packages/plugins/source-ats-jazzhr` — service, constants, types, unit tests.

No core, models, or shared-helper changes (reuses `parseLocationList`,
`htmlToPlainText`, `markdownConverter`, `extractEmails`, `getJobTypeFromString`).

## Phases

1. **Constants/types.** URL builders (`jazzhrBoardUrl`, `jazzhrDetailUrl`,
   `jazzhrApiUrl`), `JAZZHR_DETAIL_CONCURRENCY`; `JazzHRJobListing` /
   `JazzHRJobDetail` interfaces.
2. **Board parse.** Cheerio over `#jobs_table tr`: collect `job_title_link`
   anchors, de-dupe by board code, capture location cell + inline/section
   department; read the Organization ld+json for the display name.
3. **Detail overlay.** Bounded-concurrency fetch of each detail page; parse
   `div.job_description`, `h2.job_company`, `h3.job_meta`.
4. **Map.** Build `JobPostDto` (company display name, description, location,
   department, employmentType/jobType, isRemote, canonical URL/id).
5. **Tests.** Mocked-HTTP unit suite; keep the live e2e suite.

## Risks

- **Theme variance.** Boards vary; the parse targets the stable `resumator`
  table structure and degrades to board-only fields if a detail page differs.
- **Concurrency.** `Promise.allSettled` in batches of `JAZZHR_DETAIL_CONCURRENCY`
  so one slow/failed detail never blocks or nukes the batch.
