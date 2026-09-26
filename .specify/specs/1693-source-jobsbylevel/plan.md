# Plan: 1693 — Source Job Board Plugin: Level (jobsbylevel.com), AI-rated listings

| Field        | Value      |
| ------------ | ---------- |
| Spec ID      | 1693       |
| Status       | done       |
| Last updated | 2026-09-25 |

## Approach

1. **Verify before building (T0).** Read only robots-allowed operator pages (`/llms.txt`,
   `/.well-known/api-catalog`, `/developers`, the MCP server card), then one `search_jobs` and
   one `get_job` call on `/mcp`, at least 2 s apart with the honest User-Agent. Trim the replies
   into fixtures. Result: the REST API is `/api/v1/jobs` and robots-disallowed; `/mcp` serves the
   same fields and is allowed (spec D-01).
2. **Pure helpers first** (`jobsbylevel.helpers.ts`): AI-level bands, country and label
   normalisation, location matcher, compensation, skills, URL guard, MCP payload parser (JSON,
   SSE, structured content), RSS parser, listing-page JSON-LD reader, env readers. No I/O, no
   clock.
3. **Process-wide state** (`jobsbylevel.state.ts`): a TTL cache class, the page and detail
   caches, a slot-reserving pacer and an injectable clock/sleep for tests.
4. **Service** (`jobsbylevel.service.ts`): resolve a plan from the input and env; run the MCP
   transport (paged listing → client filters → sequential detail reads within the budget) or the
   feed transport; fall back to the feed once when the MCP listing fails before any job; map
   diagnostics.
5. **Tests**: unit suites with `createHttpClient` mocked and the clock injected; mutation
   controls; a two-request live e2e.

The site value is a local constant (`JOBSBYLEVEL_SITE = 'jobsbylevel' as Site`) until the
integrator registers `Site.JOBSBYLEVEL`; the suites import the service by relative path.

## Files

| File | Change |
| ---- | ------ |
| `packages/plugins/source-jobsbylevel/package.json`, `tsconfig.json` | new package `@ever-jobs/source-jobsbylevel` |
| `packages/plugins/source-jobsbylevel/src/index.ts` | barrel: `JobsByLevelModule`, `JobsByLevelService` |
| `packages/plugins/source-jobsbylevel/src/jobsbylevel.module.ts` | Nest module |
| `packages/plugins/source-jobsbylevel/src/jobsbylevel.constants.ts` | URLs, UA, caps, bands, env names, disallow list |
| `packages/plugins/source-jobsbylevel/src/jobsbylevel.types.ts` | wire and internal types, `JobsByLevelJobPost` |
| `packages/plugins/source-jobsbylevel/src/jobsbylevel.helpers.ts` | pure helpers |
| `packages/plugins/source-jobsbylevel/src/jobsbylevel.state.ts` | cache, pacer, runtime hooks |
| `packages/plugins/source-jobsbylevel/src/jobsbylevel.service.ts` | `@SourcePlugin` service |
| `packages/plugins/source-jobsbylevel/__tests__/fixtures/*` | search page, wire reply, `get_job`, RSS, listing page |
| `packages/plugins/source-jobsbylevel/__tests__/jobsbylevel.service.spec.ts` | service suite |
| `packages/plugins/source-jobsbylevel/__tests__/jobsbylevel.helpers.spec.ts` | helper suite |
| `packages/plugins/source-jobsbylevel/__tests__/jobsbylevel.e2e-spec.ts` | live e2e |

## Registration (integrator)

- `packages/models/src/enums/site.enum.ts`: `JOBSBYLEVEL = 'jobsbylevel',` with the usual
  `// Phase NNNN: Spec 1693 — Source Job Board Plugin: Level (jobsbylevel.com) — public MCP server + RSS fallback, AI Level 1-4` comment.
  Then `JOBSBYLEVEL_SITE = Site.JOBSBYLEVEL` in `jobsbylevel.constants.ts`.
- `packages/plugins/index.ts`: `import { JobsByLevelModule } from './source-jobsbylevel';` and add
  it to the module array.
- `tsconfig.base.json` paths and `jest.config.js` `moduleNameMapper` for
  `@ever-jobs/source-jobsbylevel` → `packages/plugins/source-jobsbylevel/src/index.ts`.
- `tool_manifest.json`: `"jobsbylevel"` in `supported_sites.aggregators`.
- `packages/models/src/dtos/job-post.dto.ts`: `aiLevel?: number | null;` (1-4 AI-centrality
  rating from Level; not seniority).
- `docs/index.md` row, `docs/log.md` entry.

## Verification

`npx jest --testPathPatterns "source-jobsbylevel/__tests__/jobsbylevel\.(service|helpers)\.spec"`,
the live e2e once, and `npx tsc --project tsconfig.typecheck.json --noEmit`.
