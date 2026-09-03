# Tasks: 5091 — Source Company Plugin: RDW (Redwire Corporation)

- [x] Create Spec Kit (spec.md, plan.md, tasks.md) under `.specify/specs/5091-source-company-rdw/`
- [x] Scaffold `packages/plugins/source-company-rdw` package (package.json, tsconfig.json, index.ts, module.ts, constants.ts, service.ts)
- [x] Implement `RdwService` scraping logic (BrowserPool, search pagination, detail JSON-LD, normalization)
- [x] Register plugin in `site.enum.ts`, `packages/plugins/index.ts`, `tsconfig.base.json`, `jest.config.js`
- [x] Write unit tests with fixture HTML
- [x] Run `npx tsc --noEmit` and `npx jest --testPathPatterns source-company-rdw`
- [x] Update `docs/index.md` and `docs/log.md`
- [x] Commit, push, and open ever-jobs PR
