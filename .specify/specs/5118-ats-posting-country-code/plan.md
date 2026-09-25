# Plan: 5118 — Posting-level `countryCode` on `JobPostDto`; remove `applyCountry` overlays

| Field | Value |
|---|---|
| Spec | 5118 |
| Slug | `ats-posting-country-code` |
| Status | implemented |
| Owner | devin |
| Created | 2026-09-14 |
| Last updated | 2026-09-14 |
| Related specs | 5010 (`lever-field-mappings`), 5013 (`workday-field-mappings`) |

## Phases

1. **Models.** Add optional `countryCode?: string | null` to `JobPostDto`
   (`packages/models/src/dtos/job-post.dto.ts`), adjacent to `location`,
   documented as the ATS-declared posting-level alpha-2 code. Additive field —
   no constructor or consumer changes required.
2. **Lever.** In `source-ats-lever/src/lever.service.ts`: emit
   `parsedLocations.location` verbatim; delete the `applyCountry` helper and
   the now-unused `regionNameFromCode`/`LocationDto` imports; populate
   `countryCode: job.country ?? null` in the JobPostDto ATS block. Both public
   and authenticated paths share `buildJobPost`, so one edit covers both.
3. **Workday.** In `source-ats-workday/src/workday.service.ts`: same shape —
   `parsedLocations.location` verbatim; delete `applyCountry` and the unused
   imports; populate `countryCode` from
   `info?.jobRequisitionLocation?.country?.alpha2Code`.
4. **Tests.** Rewrite the two fold-in cases per plugin: assert `countryCode`
   carries the raw code (including unresolvable input, verbatim) and
   `location.country` is never populated from the ATS field. Add a
   multi-site case asserting the merged `location` stays country-free while
   `countryCode` is still populated.

## Packages touched

- `packages/models` — `JobPostDto.countryCode`.
- `packages/plugins/source-ats-lever` — service + spec tests.
- `packages/plugins/source-ats-workday` — service + spec tests.

## Risks

- `countryCode` on the Workday side describes the requisition location, not
  necessarily the advertised site — documented in the DTO comment and spec so
  consumers treat it as posting-level ATS metadata, not geo truth.
- Behavior change vs Specs 5010/5013: `location.country` loses the non-US
  recovery those specs added; the equivalent data is preserved one level up
  on `jobPost.countryCode`.
