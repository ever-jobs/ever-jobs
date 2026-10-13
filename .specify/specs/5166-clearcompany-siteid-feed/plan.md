# Plan 5166

| Spec | 5166 — clearcompany-siteid-feed |
| --- | --- |
| Package | packages/plugins/source-ats-clearcompany |

## Phases

1. **Constants**: `CLEARCOMPANY_CAREERS_API_HOST`, `CLEARCOMPANY_SITE_ID_RE`.
2. **Types**: `ClearCompanySiteJob`, `ClearCompanySiteJobsResponse`,
   `ClearCompanySiteLocation` alongside the legacy types.
3. **Service**: `resolveSiteId` (siteNumber → GUID slug → `?siteId=`), the
   `if (siteId)` branch in `scrape`, `fetchSiteJobs`, `collectSite` /
   `processSiteJob`, `extractSiteLocations`, `detectSiteRemote`, slug-feed
   fallback on empty/error.
4. **Tests**: `__tests__/fixtures/site-jobs.json` (wire shape captured from a
   live siteId feed) + `clearcompany.service.spec.ts`.
5. **Checks**: jest spec, tsc, `npm run lint:docs`; `docs/log.md` +
   `docs/index.md`.

## Risks

- Site feed envelope could page on very large sites — observed `totalCount`
  == `results.length` on a 158-job tenant; risk noted, single-call kept.
- A caller could pass an org GUID expecting site semantics — `/v1/{orgId}`
  returns a different (smaller, org-scoped) set; documented in the spec that
  only embed-snippet siteIds are valid input.
