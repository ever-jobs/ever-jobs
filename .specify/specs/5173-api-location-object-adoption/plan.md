# Plan: 5173 — api-location-object-adoption

| Field | Value |
| --- | --- |
| Spec ID | 5173 |
| Slug | api-location-object-adoption |
| Status | draft |
| Owner | agent |
| Created | 2026-10-09 |

## Phases

1. **Spec artifacts** — this spec + tasks; docs index/log rows.
2. **Per-plugin adoption** (gem, recruitly, arbeitsagentur, cornerstone):
   - Add `toLocationDto`/`toLocationDtos` to each plugin's `@ever-jobs/common`
     import; swap only the structured-location branch per the spec recipes.
   - Preserve every fallback chain, remote check, and `locations[]` shape
     rules (`location` = first result; `locations[]` only where already
     emitted, plus gem's deliberate multi-site fill).
   - Delete now-dead helpers only when fully unused (e.g. cornerstone's
     `locationFromObject`; gem's `parseLocationList` import if orphaned).
   - recruitly: carry the mapped DTO on the normalised job so recovered
     fields reach `JobPostDto.location`.
3. **Tests** — fixture assertions per spec (gem fixture test, recruitly +
   arbeitsagentur captured fixtures, cornerstone key-change tests).
4. **Verify** — scoped jest per plugin, full affected suite, `tsc`, `lint:docs`.
5. **PR** — branch off develop, conventional commit, release note for the
   gem `locations[]`/`dedupKey` change.

## Packages touched

`packages/plugins/source-ats-gem`, `source-ats-recruitly`,
`source-arbeitsagentur`, `source-ats-cornerstone` (+ `__tests__`/`fixtures`),
`.specify/specs/5173-*`, `docs/index.md`, `docs/log.md`.
No changes to `@ever-jobs/common` or `@ever-jobs/models`.

## Risks

- **Fallback drift** — a fallback keyed on missing object vs empty fields
  could fire differently; every `??`/guard preserved so mapper-empty hits
  the same path as absent-location today.
- **dedupKey shift (gem only)** — new multi-site `locations[]` widens the
  canonical-key site set for multi-site postings; deliberate, documented in
  the release note.
- **Normalizer drop (recruitly)** — mapped DTO fields (postalCode,
  streetAddress, extras) would die in `normaliseItem` if only
  city/state/country strings were carried; the mapped DTO is stored on the
  normalised job instead.
