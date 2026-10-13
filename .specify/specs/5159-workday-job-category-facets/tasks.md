# Tasks 5159

| Field | Value |
| ----- | ----- |
| Spec | `.specify/specs/5159-workday-job-category-facets/spec.md` |
| Plan | `.specify/specs/5159-workday-job-category-facets/plan.md` |

- [x] T1. Add `WorkdayFacet`/`WorkdayFacetValue` types + `facets` on
  `WorkdaySearchResponse`; add `WORKDAY_CATEGORY_FACET` and
  `WORKDAY_CATEGORY_FACET_CAP` constants.
- [x] T2. Refactor `scrape()`: seed page → parallel streams
  (`fetchListings` + `fetchJobCategoryMap`) via `Promise.allSettled`;
  `jobCategoryFacets` extractor; `categoryMap` into `buildResponse`/
  `processListing` department chain.
- [x] T3. Extend `__tests__/workday.service.spec.ts` per spec test plan
  (appliedFacets routing on `mockPost`).
- [x] T4. jest for the plugin + `tsc --project tsconfig.typecheck.json` +
  `lint:docs`; update `docs/index.md` + `docs/log.md`; commit, push, PR.
