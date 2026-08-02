# Tasks: 5035 — Gem detail overlay

- [x] T1 — Add `GEM_JOB_BOARD_DETAIL_QUERY`, `GEM_DETAIL_CONCURRENCY`, and
      `GEM_EMPLOYMENT_TYPE_LABELS` to `gem.constants.ts`.
      AC: detail query + concurrency constant + enum→label map exported.
- [x] T2 — Model `GemExternalJobPosting` / `GemDetailEnvelope` in `gem.types.ts`.
      AC: detail carries descriptionHtml/firstPublishedTsSec/startDateTs/compensationHtml.
- [x] T3 — Cap postings to `resultsWanted`, then overlay each detail via the
      batched `ExternalJobPostingQuery` POST under bounded concurrency.
      AC: failed fetch → list-only fields (never throws).
- [x] T4 — Map `description` (formatted), `datePosted` (Unix-seconds → Date),
      `compensation` (free-text parse), `employmentType`/`jobType`; emit the
      canonical `/{slug}/{extId}` URL.
      AC: URL drops `/jobs/`; employmentType humanised from the list enum.
- [x] T5 — Unit tests (mocked HTTP) per the spec test plan.
      AC: `npx jest source-ats-gem` green.
