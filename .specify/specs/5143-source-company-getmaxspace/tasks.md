# Tasks: 5143 — source-company-getmaxspace

- [x] 1. Scaffold `packages/plugins/source-company-getmaxspace/` —
  package.json, tsconfig.json, `src/index.ts`, `getmaxspace.module.ts`,
  `getmaxspace.constants.ts`, `getmaxspace.types.ts`.
  - AC: package imports as `@ever-jobs/source-company-getmaxspace`.
- [x] 2. Implement `GetMaxSpaceService.scrape`: one GET → cheerio →
  `a.career-jobs_cms-link` items → title/department/employmentType/
  location + Indeed `jobUrl`; `id` from `/job/` hex or `jk` param.
  - AC: 5 live items map to jobs.
- [x] 3. Register in `site.enum.ts` (`GETMAXSPACE`, Phase 1700),
  `plugins/index.ts`, `tsconfig.base.json`, `jest.config.js`.
  - AC: `siteType: ['getmaxspace']` resolves.
- [x] 4. Unit tests + fixture: 5-job mapping, id variants, `&amp;`
  decode, `empty`, fetch failure, input filters.
  - AC: `npx jest source-company-getmaxspace` green.
- [x] 5. `tsc` + `lint:docs` clean; docs/index.md row + docs/log.md
  entry; PR to `develop`.
  - AC: PR open, CI green.
