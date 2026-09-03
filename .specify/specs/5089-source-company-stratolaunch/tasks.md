# Tasks: 5089 — Source Company Plugin: Stratolaunch

- [x] T1 — Scaffold `packages/plugins/source-company-stratolaunch/` package files and captured Greenhouse API fixture. Acceptance: package compiles and fixture is valid JSON.
- [x] T2 — Register `Site.STRATOLAUNCH` and `StratolaunchModule` in site enum, plugin barrel, `tsconfig.base.json`, and `jest.config.js`. Acceptance: module imports resolve.
- [x] T3 — Implement `StratolaunchService.scrape()` against the Greenhouse Job Board API. Acceptance: fixture maps to `JobPostDto` with all required fields and filters work.
- [x] T4 — Add `__tests__/stratolaunch.service.spec.ts`. Acceptance: all tests pass.
- [x] T5 — Update `docs/index.md` and `docs/log.md` with Spec 5089. Acceptance: no broken links.
- [x] T6 — Run `tsc --noEmit` and the plugin Jest suite. Acceptance: all green.
- [ ] T7 — Push branch and open PR. Acceptance: PR description follows the concise external-audience format.
