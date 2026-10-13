# Plan 5159

| Field | Value |
| ----- | ----- |
| Spec | `.specify/specs/5159-workday-job-category-facets/spec.md` |
| Package | `packages/plugins/source-ats-workday` |

## Phase 1 — types & constants

- `workday.types.ts`: add `WorkdayFacetValue` (`descriptor`, `id`, `count`),
  `WorkdayFacet` (`facetParameter`, `descriptor`, `values`), and
  `facets?: WorkdayFacet[] | null` on `WorkdaySearchResponse`.
- `workday.constants.ts`: add `WORKDAY_CATEGORY_FACET = 'jobFamilyGroup'`
  and `WORKDAY_CATEGORY_FACET_CAP = 50`.

## Phase 2 — service

- First `POST /jobs` unfiltered at offset 0 seeds both the listing set and
  the facet catalog (zero extra calls to enumerate categories).
- `jobCategoryFacets(searchResponse)` → `{ id, label }[]` for
  `facetParameter === 'jobFamilyGroup'` (id + descriptor required, capped
  at `WORKDAY_CATEGORY_FACET_CAP`).
- Stream A = `fetchListings` (existing loop, fetch moved to loop end so the
  seed page is absorbed first — identical stop conditions/dedupe/sleeps).
- Stream B = `fetchJobCategoryMap` (sequential per-bucket pagination via
  `appliedFacets`, identical stop conditions/sleep →
  `Map<workdayListingKey, descriptor>`).
- `Promise.allSettled([streamA, streamB])`: A rejection → existing classified
  error path; B rejection → warn + empty map.
- `buildResponse`/`processListing` take `categoryMap`;
  `department: jobFamily[0].name ?? categoryMap.get(key) ?? subtitles[0]`.

## Phase 3 — tests & docs

- Extend `__tests__/workday.service.spec.ts` (route `mockPost` by payload
  `appliedFacets`) per spec test plan.
- `docs/index.md` row + `_Last revised_` footer; `docs/log.md` prepend.

## Risks

- Tenant without facets → zero extra calls (spec-verified path).
- Facet values missing `id`/`descriptor` are dropped before paging.
- Buckets never dedupe against each other — `jobFamilyGroup` is
  single-valued; a listing re-appearing simply re-sets the same key.
