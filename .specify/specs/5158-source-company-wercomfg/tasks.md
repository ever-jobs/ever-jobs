# Tasks: 5158

| Field | Value |
| --- | --- |
| Spec | 5158 |
| Title | Source Company Plugin: Werco Manufacturing (wercomfg.com) |

- [x] T1. Capture fixtures: live `/careers` index + two detail pages into
      `__tests__/fixtures/`.
- [x] T2. Author `.specify/specs/5158-source-company-wercomfg/{spec,plan,tasks}.md`.
- [x] T3. Create `packages/plugins/source-company-wercomfg/` package:
      constants, types, service (index-link crawl → per-page `JobPosting`
      JSON-LD → `JobPostDto`), module, index, package.json, tsconfig.
- [x] T4. Register in four places: `site.enum.ts` (`WERCOMFG`, Phase 1712),
      `plugins/index.ts` (`WercoMfgModule` + `ALL_SOURCE_MODULES`),
      `tsconfig.base.json` paths, `jest.config.js` moduleNameMapper.
- [x] T5. Write `__tests__/wercomfg.service.spec.ts` on the fixtures.
- [x] T6. Run jest (plugin suite), `tsc --project tsconfig.typecheck.json`,
      `npm run lint:docs`.
- [x] T7. Verify live: scrape `wercomfg.com/careers` → 11 jobs with JSON-LD
      fields populated.
- [x] T8. Update `docs/index.md` (5158 row + footer) and `docs/log.md`.
- [x] T9. Commit, push, open PR to `develop`.
