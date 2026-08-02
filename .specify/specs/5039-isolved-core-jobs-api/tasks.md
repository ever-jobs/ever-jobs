# Tasks: 5039 — isolved-core-jobs-api

| Field | Value |
| --- | --- |
| Spec ID | 5039 |
| Slug | isolved-core-jobs-api |
| Status | implemented |

## Task list

- [x] T1 — Probe live boards; identify `/core/jobs/{domainId}` API, verify
  independent ground-truth counts vs sitemap vs plugin (5 tenants: 38/14/9/7/5)
- [x] T2 — Diagnose field gaps (department null, no compensation, text-only isRemote)
- [x] T3 — Update `isolved.constants.ts`: add core-jobs path, board-meta regexes,
  workplace-remote regex, iso3→iso2 map, getParams config
- [x] T4 — Update `isolved.types.ts`: add `IsolvedApiJob`, `IsolvedBoardMeta`;
  remove unused sitemap-only types
- [x] T5 — Rewrite `isolved.service.ts`: list-API enumeration + detail-JSON-LD
  description hybrid, department/compensation/structured-isRemote mapping
- [x] T6 — Write mocked-HTTP unit tests (`isolved.service.spec.ts`): board-meta
  extraction, API parse, single-job mapping, detail merge, resultsWanted cap,
  workplaceType→isRemote, compensation parsing, graceful degradation (15 tests)
- [x] T7 — Update `docs/index.md`, `docs/log.md`, `docs/questions.md`
