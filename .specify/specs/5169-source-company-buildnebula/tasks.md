# Tasks 5169 — Source Company Plugin: Nebula (buildnebula.com)

- [x] 1. Scaffold `packages/plugins/source-company-buildnebula/` (package.json,
  tsconfig.json, module, service, constants, types, index barrel).
      Acceptance: package compiles in isolation.
- [x] 2. Register `Site.BUILDNEBULA` + module + tsconfig path + jest mapper
  (all four places).
      Acceptance: `Site.BUILDNEBULA === 'buildnebula'`; registry import resolves.
- [x] 3. Implement `BuildnebulaService.scrape`: GET
  `{origin}/api/careers/listings`, map items per spec contract, input filtering.
      Acceptance: live shape maps cleanly; unpublished/takedown filtered.
- [x] 4. Unit tests (`__tests__/buildnebula.service.spec.ts` +
  `fixtures/listings.json`): mapping, team labels, locations, compensation,
  description sections, visibility gating, filters, empty + error diagnostics.
      Acceptance: `npx jest source-company-buildnebula` green.
- [x] 5. `npm run tsc` + `npm run lint:docs` clean; `docs/index.md` +
  `docs/log.md` updated; commit, push, PR to `develop`.
      Acceptance: PR open with green local checks.
