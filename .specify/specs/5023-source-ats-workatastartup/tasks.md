# Tasks: 5023 — `source-ats-workatastartup`

- [x] T1. Scaffold `packages/plugins/source-ats-workatastartup/` (package.json,
      tsconfig.json, src/index.ts).
      _Acceptance:_ package resolves under the `@ever-jobs/...` alias.
- [x] T2. `workatastartup.constants.ts` — hosts, URL builders
      (`companyJobsUrl`, `canonicalCompanyUrl`, `detailUrl`), headers,
      concurrency + result caps.
- [x] T3. `workatastartup.types.ts` — `WaasJobPosting`, `WaasCompany`,
      `WaasPageProps`, `WaasInertiaPage`.
- [x] T4. `workatastartup.service.ts` — `extractInertiaPage` (data-page
      attribute → unescape → JSON.parse, defensive), `scrape`, `fetchDetail`
      (bounded concurrency, allSettled), `processJob` (full field mapping
      reusing common helpers).
      _Acceptance:_ list spine + ld+json overlay merge into JobPostDto[].
- [x] T5. `workatastartup.module.ts` + barrel.
- [x] T6. Register in four places (Site enum, plugins/index.ts,
      tsconfig.base.json, jest.config.js).
- [x] T7. Capture trimmed real fixtures (diode list+2 details, loombotic
      list+1 detail) under `__tests__/fixtures/`.
- [x] T8. Unit tests `__tests__/workatastartup.service.spec.ts` covering list
      parse, detail overlay, compensation (structured + hourly text),
      multi-location, mapping, robustness.
      _Acceptance:_ suite green.
- [x] T9. `npm run build` + `npm run lint:docs` green; network-gated smoke.
- [x] T10. Docs — index/log/questions; open PR to `makedeeply`.
