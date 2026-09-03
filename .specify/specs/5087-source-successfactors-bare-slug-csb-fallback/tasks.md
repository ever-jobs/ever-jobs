# Tasks: 5087 — SuccessFactors bare-slug CSB fallback

- [x] T1 — Add `buildSfCsbDefaultOrigin(companyId)` helper and `SF_CSB_DEFAULT_ORIGIN_TEMPLATES` constant in `successfactors.constants.ts`. Acceptance: unit tests for the builder; `tsc --noEmit` clean.
- [x] T2 — Update `SuccessFactorsService.scrape()` to detect bare slugs, skip OData/native HTML, probe the default CSB origin, and fall back to a clear diagnostic. Acceptance: the existing `__tests__/successfactors-csb.service.spec.ts` still passes.
- [x] T3 — Extend `__tests__/successfactors-csb.service.spec.ts` with bare-slug success/failure cases and colon-slug unchanged case. Acceptance: new tests pass.
- [x] T4 — Update `docs/index.md` and `docs/log.md` with Spec 5087 row/entry. Acceptance: `lint:docs` clean if available.
- [x] T5 — Push branch, open PR, verify CI/tests green.
