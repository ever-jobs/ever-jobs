# Tasks: 5142 — source-company-mundane_co

- [x] 1. Scaffold `packages/plugins/source-company-mundane_co/` —
  package.json, tsconfig.json, `src/index.ts`, `mundane-co.module.ts`,
  `mundane-co.constants.ts`, `mundane-co.types.ts`.
  - AC: package imports as `@ever-jobs/source-company-mundane_co`.
- [x] 2. Implement `MundaneCoService.scrape`: `/join-us` shell →
  `/assets/index-*.js` bundle → entry-shape job extraction; mapping to
  `JobPostDto` (ids, department, location, cleaned urls).
  - AC: 10 live entries map to jobs without headless.
- [x] 3. Airtable descriptions: render each Airtable apply URL via
  `BrowserPool`, extract form description (selector list + longest-
  paragraph fallback), attach as `description`; LinkedIn URLs skipped;
  render failure emits the job anyway.
  - AC: description present for Airtable jobs, absent for LinkedIn jobs.
- [x] 4. Register in `site.enum.ts` (`MUNDANE_CO`, Phase 1699),
  `plugins/index.ts`, `tsconfig.base.json`, `jest.config.js`.
  - AC: `siteType: ['mundane_co']` resolves; `companyDomains:
    ['mundane.co']` claimed.
- [x] 5. Unit tests + bundle fixture: mapping, id variants, descriptions,
  render fallback, `empty`, `resultsWanted`/`searchTerm`/`location`,
  LinkedIn query-strip.
  - AC: `npx jest source-company-mundane_co` green.
- [x] 6. `tsc --project tsconfig.typecheck.json --noEmit` + `npm run
  lint:docs` clean; `docs/index.md` row + `docs/log.md` entry; PR to
  `develop`.
  - AC: PR open, CI green.
