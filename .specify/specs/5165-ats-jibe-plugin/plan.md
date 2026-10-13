# Plan 5165

| Spec | 5165 — ats-jibe-plugin |
| --- | --- |
| Package | packages/plugins/source-ats-jibe (+ registrations) |
| Effort | small — one adapter + tests |

## Approach

- Scaffold `packages/plugins/source-ats-jibe/` following the `source-ats-icims` layout
  (package.json, tsconfig, `src/{index,module,service,constants,types}.ts`, `__tests__/`).
- `jibe.constants.ts`: `JIBE_API_PATH`, fixed `JIBE_PAGE_SIZE=10`, caps, headers,
  `buildJibeApiUrl`/`buildJibeJobUrl`.
- `jibe.types.ts`: `JibeJobData`, `JibeJobsPage`, `JibeTarget`.
- `jibe.service.ts`: `JibeService implements IScraper` —
  - `resolveTarget(companySlug, companyUrl)`: first value that URL-parses to a host
    wins; `mountFromPath` = segments before the last `jobs` segment → `detailBase`.
  - `fetchJobsPage`: `GET {origin}/api/jobs?page=N`; non-`jobs` body or 4xx → null
    (degrade), other errors propagate to the catch (partial results preserved).
  - `toJobPost`: field mapping per spec; `hiring_organization` → companyName with
    `companyFromHost` fallback (`careers.rivian.com` → `Rivian`).
- Register in four places: `Site.JIBE` (`site.enum.ts`, beside `ICIMS`),
  `JibeModule` in `ALL_SOURCE_MODULES`, tsconfig path alias, jest `moduleNameMapper`.
- Tests: `__tests__/jibe.service.spec.ts` mocking `@ever-jobs/common`'s
  `createHttpClient` (same pattern as the icims spec).

## Risks

- `pageSize` is server-fixed at 10 — a ~800-job tenant costs ~80 requests; the loop
  honours `requestTimeout` and stops on the first empty page.
- Mount-path detection is heuristic (everything before the last `jobs` segment);
  bare-slug calls fall back to `{origin}/jobs/{slug}` which Jibe sites redirect
  to the mounted detail page.
