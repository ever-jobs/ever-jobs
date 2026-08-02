# Tasks: 5037 — oracle-slug-pagination

| Field | Value |
| --- | --- |
| Spec ID | 5037 |
| Status | implemented |
| Created | 2026-07-07 |

- [x] T01: Add `ORACLE_DEFAULT_HOST_SEGMENT` constant + barrel export
- [x] T02: `parseSlug` — accept `{fullHost}:{site}`, `{sub}:{site}`, legacy `{sub}-{region}`
- [x] T03: `siteNumberFromUrl` — extract `siteNumber` from `/sites/{CX}` in `companyUrl`
- [x] T04: Rewrite `resolveTenant` to return `{ tenant, siteNumber }`
- [x] T05: `scrape` — siteNumber precedence: `input.siteNumber > slug > URL > default`
- [x] T06: Pagination — terminate on `TotalJobsCount` / empty page, not short-page heuristic
- [x] T07: Remove dead `extractRequisitions` (inlined into pagination loop)
- [x] T08: Update class-level JSDoc for new slug forms
- [x] T09: Unit tests — colon-slug forms (full-host, bare-sub, us8 region, override)
- [x] T10: Unit test — siteNumber extraction from companyUrl path
- [x] T11: Unit tests — pagination short-mid-page (100+99+45=244) + resultsWanted cap
- [x] T12: Live validation against 4 tenants (ocs/CX_1=243, us8/CX_1=19, us8/CX_2=96, us6/CX=158)
- [x] T13: Spec Kit docs (spec.md, plan.md, tasks.md)
- [x] T14: docs/index.md, docs/log.md updates
- [x] T15: PR with full description
