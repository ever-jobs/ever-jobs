# Plan 5160

| Field | Value |
| ----- | ----- |
| Spec | `.specify/specs/5160-workday-category-facet-variants/spec.md` |
| Package | `packages/plugins/source-ats-workday` |

## Phase 1 — constants & types

- `workday.constants.ts`: replace `WORKDAY_CATEGORY_FACET` with
  `WORKDAY_CATEGORY_FACET_PATTERN = /categor|famil|depart/i`,
  `WORKDAY_NON_CATEGORY_FACET_PARAMETERS` (explicit set), and
  `WORKDAY_NON_CATEGORY_FACET_PATTERN` (name guard). Keep
  `WORKDAY_CATEGORY_FACET_CAP`.
- `workday.types.ts`: `WorkdayFacetValue` gains optional `facetParameter` /
  `values` so a facet group's nested facets are typed.

## Phase 2 — service

- `jobCategoryFacets` → `jobCategoryFacet`: flatten top-level facets plus
  group-nested ones, drop non-category parameters, keep facets whose
  parameter or descriptor matches the category pattern, pick the qualifier
  with the largest coverage. Returns `{ parameter, values }` so
  `fetchJobCategoryMap` can key `appliedFacets` by the chosen parameter.

## Phase 3 — tests

Add the spec-5160 describe (renamed parameters, omit-list suppression,
coverage pick, nested group); keep the 5159 suite passing.

## Phase 4 — verify & docs

Live-run `zekelman:12:Careers` and `wisk:108:Wisk_Careers` (tmp_live jest
pattern); `docs/index.md` row + footer, `docs/log.md` prepend.

## Risks

- A tenant could name a *location* facet something category-worded —
  mitigated by the omit-list + parameter guard; worst case a wrong facet is
  bucketed and `department` gets a location-ish label for a minority of
  postings. Accepted: bounded, visible.
