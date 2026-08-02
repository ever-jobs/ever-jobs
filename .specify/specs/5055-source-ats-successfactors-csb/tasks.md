# Tasks: 5055 — source-ats-successfactors Career Site Builder reader

- [x] T1. Add CSB constants + helpers to `successfactors.constants.ts`
  - `SF_CSB_PAGE_SIZE`, `SF_CSB_MAX_PAGES`, `SF_CSB_DETAIL_CONCURRENCY`.
  - `SF_CSB_FINGERPRINTS`, `SF_INSTANCE_RE`, `SF_COMPANY_ID_RE`,
    `SF_CSB_JOB_LINK_RE`.
  - `htmlLooksLikeCsb`, `resolveCsbBaseUrl`, `buildSfCsbTileUrl`.
  - Acceptance: helpers unit-tested; base resolves to origin; regex extracts the
    id even when the slug embeds a zip.

- [x] T2. Add CSB types to `successfactors.types.ts`
  - `SfCsbListItem`, `SfCsbDetail`.

- [x] T3. Rework `scrape()` switch (OData → CSB → careersection)
  - Tolerate missing slug (CSB-only) and missing portal (OData-only).
  - Acceptance: no slug + no url → `[]`; CSB runs when OData yields zero.

- [x] T4. Implement the CSB reader in `successfactors.service.ts`
  - `collectCsbTiles`, `parseCsbTiles`, `fetchCsbDetails` (bounded
    `Promise.allSettled`), `parseCsbDetail` (microdata), `toCsbJobPost`,
    `formatDescription`, `absoluteUrl`.
  - Protected fetch seams `fetchCsbTileHtml` / `fetchCsbDetailHtml`; OData/HTML
    scrape methods promoted to `protected` for testability.
  - Acceptance: tile + detail microdata → full `JobPostDto`; pagination +
    de-dupe; `resultsWanted` cap; missing detail still emits the role.

- [x] T5. Unit tests `__tests__/successfactors-csb.service.spec.ts`
  - Mapping, pagination/de-dupe, cap, missing-detail fallback, empty inputs,
    helper tests. Acceptance: suite green; package typecheck clean.

- [x] T6. Docs
  - `docs/index.md` (spec index entry), `docs/log.md` (newest-at-top),
    `docs/ATS_INTEGRATIONS.md` (SuccessFactors CSB surface), `docs/questions.md`
    (sub-path portals + custom-domain detection open question).
