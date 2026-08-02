# Tasks: 5034 — JazzHR board rework

- [x] T1 — Add URL builders + `JAZZHR_DETAIL_CONCURRENCY` to `jazzhr.constants.ts`.
      AC: board/detail/api URL helpers; concurrency constant exported.
- [x] T2 — Model `JazzHRJobListing` / `JazzHRJobDetail` in `jazzhr.types.ts`.
      AC: listing carries code/title/location/department/jobUrl; detail carries
      description/employmentType/companyName.
- [x] T3 — Parse `#jobs_table` via Cheerio, de-dupe by board code, capture
      location + inline/section department; read Organization ld+json name.
      AC: one listing per role; no mobile-copy duplicates.
- [x] T4 — Overlay each detail page under bounded concurrency; parse body,
      `h2.job_company`, `h3.job_meta` employment type.
      AC: failed fetch → board-only fields (never throws).
- [x] T5 — Map to `JobPostDto` (company display name, description, location,
      department, employmentType/jobType, isRemote, canonical URL/id).
      AC: `companyName` is the display name, not the slug.
- [x] T6 — Retain the authenticated Resumator API path; emit canonical URL +
      jobType.
      AC: API path still maps title/location/department/datePosted.
- [x] T7 — Unit tests (mocked HTTP) per the spec test plan; keep live e2e.
      AC: `npx jest source-ats-jazzhr` green.
