# Tasks: 5139 — `source-ats-wellfound`: slug-keyed Wellfound company boards

| Field | Value |
| --- | --- |
| Spec ID | 5139 |
| Slug | source-ats-wellfound |
| Status | implemented |
| Owner | agent |
| Created | 2026-09-23 |

- [x] 1. Scaffold `packages/plugins/source-ats-wellfound/` (package.json,
      tsconfig.json, index.ts, module, constants, types).
- [x] 2. Implement `resolveSlug` — `companyUrl` `/company/{slug}` or
      `companySlug`; neither → `bad_input`.
- [x] 3. Implement `scrape` — BrowserPool page, `?page=N` loop with
      dedupe-by-id termination + `resultsWanted` cap,
      `looksLikeChallenge`/missing `__NEXT_DATA__` → `blocked`,
      `totalPageCount` truncation warning.
- [x] 4. Implement `mapListing` + `parseCompensationString` field
      mapping per spec table.
- [x] 5. Register: `Site.WELLFOUND_ATS`, `ALL_SOURCE_MODULES`,
      `tsconfig.base.json` paths, `jest.config.js` `moduleNameMapper`.
- [x] 6. Unit tests: resolution, enumeration+dedupe, field mapping,
      `bad_input`, `blocked`, cap.
- [x] 7. `npx jest` on the new package, `tsc` typecheck, `npm run
      lint:docs`.
- [x] 8. `docs/index.md` row + `docs/log.md` entry; conventional
      commit; PR to `develop`.
