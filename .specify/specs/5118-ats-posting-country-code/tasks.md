# Tasks: 5118 — Posting-level `countryCode` on `JobPostDto`; remove `applyCountry` overlays

| Field | Value |
|---|---|
| Spec | 5118 |
| Slug | `ats-posting-country-code` |
| Status | implemented |
| Owner | devin |
| Created | 2026-09-14 |
| Last updated | 2026-09-14 |
| Related specs | 5010 (`lever-field-mappings`), 5013 (`workday-field-mappings`) |

- [x] T01 — Add `countryCode?: string | null` to `JobPostDto` in `packages/models/src/dtos/job-post.dto.ts` (posting-level alpha-2, verbatim).
- [x] T02 — `source-ats-lever`: delete `applyCountry`; emit `parsedLocations.location` verbatim; set `countryCode: job.country ?? null`; drop unused `regionNameFromCode`/`LocationDto` imports.
- [x] T03 — `source-ats-workday`: delete `applyCountry`; emit `parsedLocations.location` verbatim; set `countryCode` from `jobPostingInfo.jobRequisitionLocation.country.alpha2Code`; drop unused imports.
- [x] T04 — Update unit tests in both plugins: `countryCode` verbatim (resolvable + unresolvable), `location.country` never populated from the ATS field, absent code → `null`.
- [x] T05 — Run focused jest for both plugins + `tsc --noEmit` on the three touched packages; run `lint:docs`.
