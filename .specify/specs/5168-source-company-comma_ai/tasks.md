# Tasks — Spec 5168 `source-company-comma_ai`

- [x] Scaffold `packages/plugins/source-company-comma_ai/` (package.json,
      tsconfig.json, src/, __tests__/fixtures)
- [x] `comma-ai.types.ts` — `CommaAiJobEntry` (title/team?/location/
      description/qualifications/howToApply)
- [x] `comma-ai.constants.ts` — origin, careers URL, node-chunk URL regex,
      jobs-array anchor regex, backtick-aware helpers' inputs
- [x] `comma-ai.service.ts` — fetchJobs (HTML → node chunks → jobs array),
      parseJobsArray/parseEntry (balancedSlice/splitTopLevel/scalarField/
      templateField/arrayField), toJobPost, applyInput filters
- [x] `comma-ai.module.ts` + `index.ts` barrel
- [x] Register `Site.COMMA_AI` + `ALL_SOURCE_MODULES` + tsconfig path +
      jest moduleNameMapper
- [x] Unit tests: 10-job fixture scrape, slug derivation, team optional,
      location parse, description composition, empty diagnostics
- [x] docs/index.md row + `_Last revised_` + docs/log.md entry
- [x] `npx jest`, `tsc --noEmit`, `npm run lint:docs` green; commit, push, PR
