# Tasks 5160

| Field | Value |
| ----- | ----- |
| Spec | `.specify/specs/5160-workday-category-facet-variants/spec.md` |
| Plan | `.specify/specs/5160-workday-category-facet-variants/plan.md` |

- [x] T1. Constants: `WORKDAY_CATEGORY_FACET_PATTERN`,
  `WORKDAY_NON_CATEGORY_FACET_PARAMETERS`,
  `WORKDAY_NON_CATEGORY_FACET_PATTERN`; keep `WORKDAY_CATEGORY_FACET_CAP`.
- [x] T2. Types: nested-facet fields on `WorkdayFacetValue`.
- [x] T3. `jobCategoryFacet`: flatten groups, omit-list, category-word match,
  max-coverage pick; `fetchJobCategoryMap` keys `appliedFacets` by the
  chosen parameter.
- [x] T4. Tests: `jobFamily` + `Department_Extended` shapes, omit-list
  suppression, coverage pick, nested group; 5159 suite green (62 total).
- [x] T5. `jest` + `tsc --project tsconfig.typecheck.json` +
  `npm run lint:docs`.
- [ ] T6. Live verify `zekelman:12:Careers` + `wisk:108:Wisk_Careers`.
- [ ] T7. `docs/index.md` row + footer, `docs/log.md` prepend; commit, push,
  PR to develop.
