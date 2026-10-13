# Tasks 5170 — Source Company Plugin: Minerva Humanoids (minervahumanoids.com)

- [ ] 1. Scaffold `packages/plugins/source-company-minervahumanoids/`
  (package.json, tsconfig.json, module, service, constants, types,
  index barrel).
      Acceptance: package compiles in isolation.
- [ ] 2. Register `Site.MINERVAHUMANOIDS` + module + tsconfig path +
  jest mapper (all four places).
      Acceptance: `Site.MINERVAHUMANOIDS === 'minervahumanoids'`; registry
      import resolves.
- [ ] 3. Implement `MinervaHumanoidsService.scrape`: GET
  `{origin}/content/published.js`, parse `window.__minervaContent`, map
  `content.jobs[]` per spec contract, input filtering.
      Acceptance: live shape maps cleanly; `published:false` dropped.
- [ ] 4. Unit tests (`__tests__/minervahumanoids.service.spec.ts` +
  `fixtures/published.js`): mapping, apply-anchor selection, location
  parsing, block flattening, published gating, filters, empty + error
  diagnostics.
      Acceptance: `npx jest source-company-minervahumanoids` green.
- [ ] 5. `npm run tsc` + `npm run lint:docs` clean; `docs/index.md` +
  `docs/log.md` updated; commit, push, PR to `develop`.
      Acceptance: PR open with green local checks.
