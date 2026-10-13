# Tasks: 5174 — comeet-careers-page-positions

- [x] Write spec-kit artifacts (spec.md, plan.md, tasks.md)
- [x] Rewrite `comeet.service.ts`: companyUrl/fallback page fetch,
      bracket-balanced `COMPANY_POSITIONS_DATA`/`COMPANY_DATA` extraction,
      per-position mapping (toLocationDto, structured isRemote,
      employmentType, applyUrl, custom_fields.details description)
- [x] Add `__tests__/fixtures/comeet-careers.html` (captured page, 2 real
      positions) and `__tests__/comeet.service.spec.ts` covering mapping,
      isRemote, companyUrl, resultsWanted, marker-free → [], fetch failure
      → classified error
- [x] Run the comeet jest suite + `tsc --noEmit -p tsconfig.typecheck.json`
      + `npm run lint:docs`
- [x] Update `docs/index.md` + `docs/log.md`
- [x] Branch off develop, commit, push, open PR

## Acceptance

- Fixture scrape returns 2 `JobPostDto`s with all mapped fields correct;
  remote and empty/marker-free cases pass; tsc + lint:docs clean.
