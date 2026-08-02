# Plan: 5035 — Gem detail overlay

| Field | Value |
| --- | --- |
| Spec ID | 5035 |
| Status | implemented |
| Created | 2026-06-28 |

## Packages touched

- `packages/plugins/source-ats-gem` — service, constants, types, unit tests.

No core, models, or shared-helper changes (reuses `markdownConverter`,
`htmlToPlainText`, `extractEmails`, `resolveCompensation`, `getJobTypeFromString`).

## Phases

1. **Constants/types.** Add `GEM_JOB_BOARD_DETAIL_QUERY` (ExternalJobPostingQuery),
   `GEM_DETAIL_CONCURRENCY`, and the `GEM_EMPLOYMENT_TYPE_LABELS` enum→label map;
   model `GemExternalJobPosting` / `GemDetailEnvelope`.
2. **Detail overlay.** Cap postings to `resultsWanted`, then fetch each detail via
   the batched `ExternalJobPostingQuery` POST under `Promise.allSettled` batches.
3. **Map.** Overlay `description` (formatted), `datePosted` (Unix-seconds → Date),
   `compensation` (free-text parse); map `employmentType`/`jobType`; emit the
   canonical `/{slug}/{extId}` URL.
4. **Tests.** Extend the mocked-HTTP unit suite with a detail-overlay case; fix
   the URL assertion; keep the existing cases.

## Risks

- **Per-posting fan-out.** N extra POSTs per board; bounded by
  `GEM_DETAIL_CONCURRENCY` and applied only after the `resultsWanted` cap.
- **Free-text pay.** `compensationHtml` is prose; the shared salary extractor
  parses bounded ranges and yields nothing when no range is present (no false
  positives).
