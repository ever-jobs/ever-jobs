# Tasks 5166

| Spec | 5166 — clearcompany-siteid-feed |
| --- | --- |
| Package | packages/plugins/source-ats-clearcompany |

- [x] `clearcompany.constants.ts`: `CLEARCOMPANY_CAREERS_API_HOST`,
  `CLEARCOMPANY_SITE_ID_RE`.
- [x] `clearcompany.types.ts`: `ClearCompanySiteJob`,
  `ClearCompanySiteJobsResponse`, `ClearCompanySiteLocation`.
- [x] `clearcompany.service.ts`: `resolveSiteId`, site-mode branch in
  `scrape`, `fetchSiteJobs`, `collectSite`, `processSiteJob`,
  `extractSiteLocations`, `detectSiteRemote`, slug fallback.
- [x] Tests: fixture + spec covering GUID slug, `siteNumber`, `?siteId=`
  URL, field mapping, empty-feed fallback, slug-only path, unknown-site 404.
- [x] `npx jest` the new spec + `npx tsc -p tsconfig` + `npm run lint:docs`.
- [ ] `docs/index.md` row + `_Last revised_` footer; `docs/log.md` prepend.
- [ ] Commit, push, PR to develop.
