# Plan: 1720 — List mode (no keyword) and source selection by category

| Field        | Value      |
| ------------ | ---------- |
| Spec ID      | 1720       |
| Status       | done       |
| Last updated | 2026-09-24 |

## Approach

1. **Models.** Add `SITE_CATEGORIES` / `SiteCategory` / `isSiteCategory` in
   `packages/models/src/enums/site-category.enum.ts`; add `siteCategories` to `ScraperInputDto`
   with `@IsArray() @IsIn(SITE_CATEGORIES, { each: true })`.
2. **Plugin metadata.** `PluginCategory` becomes an alias of `SiteCategory` (same union, one
   source of truth); add `requiresSearchTerm?: boolean`. Flag `source-bayt` and `source-naukri`.
3. **API helpers** (`apps/api/src/jobs/search-input.ts`): `normalizeSearchTerm`,
   `normalizeSearchInput` (mutating, idempotent), `isListMode`, `describeTerm` (for logs),
   `parseSiteCategories` (throws `BadRequestException` naming the allowed values).
4. **JobsService.** Normalise the input first. Compute the default selection exactly as today,
   then (only when no explicit site was resolved) intersect it with `siteCategories`. In list
   mode, partition out `requiresSearchTerm` plugins and emit their `empty` rows. Accept an
   optional `{ onProgress }` (used by Spec 1721); edits in the worker loop are two
   `progress` calls so a concurrent branch that touches `scrapeOne` rebases cleanly.
5. **Controller / resolver.** Normalise before the cache lookup; log `term=<none>`. GraphQL input
   gains `siteCategories`; `searchTerm` becomes nullable.

## Files

| File | Change |
| ---- | ------ |
| `packages/models/src/enums/site-category.enum.ts` | new |
| `packages/models/src/enums/index.ts` | export |
| `packages/models/src/dtos/scraper-input.dto.ts` | `siteCategories` |
| `packages/plugin/src/interfaces/plugin-metadata.interface.ts` | alias + `requiresSearchTerm` |
| `packages/plugins/source-bayt/src/bayt.service.ts`, `packages/plugins/source-naukri/src/naukri.service.ts` | `requiresSearchTerm: true` |
| `apps/api/src/jobs/search-input.ts` | new |
| `apps/api/src/jobs/jobs.service.ts` | normalise, categories, list-mode partition, progress hook |
| `apps/api/src/jobs/jobs.controller.ts`, `jobs.resolver.ts`, `gql-types.ts` | log + normalise + GraphQL fields |
| tests | see spec §8 |

## Risks

- **Concurrent edits to `jobs.service.ts`** (a politeness branch wraps `scrapeOne`). Mitigation:
  no edits inside `scrapeOne`; worker-loop edits are additive single lines.
- **A plugin that misbehaves without a keyword and is not flagged.** Mitigation: the fan-out
  already isolates throws; the static guard stops new bare interpolations; Q-100 records the
  flagging policy.

## Verification

Targeted jest suites for `apps/api/src/jobs`, `apps/api/src/config`, `packages/plugin`,
`packages/models`; `tsc --noEmit -p apps/api/tsconfig.json`; `npm run lint:docs`.
