# Plan: 5151

| Field | Value |
| ----- | ----- |
| Spec ID | 5151 |
| Slug | source-company-labs_actor |
| Status | Done |
| Owner | Devin (for MakeDeeply) |

## Approach

Static-fetch company plugin (same bundle-array shape as
`source-company-4earth_tech`, with one extra hop because the data sits
in a lazy chunk):

1. Scaffold `packages/plugins/source-company-labs_actor/` —
   package.json, tsconfig, `src/{index,module,service,constants,
   types}.ts`, `__tests__/`.
2. `labs-actor.service.ts` — `@SourcePlugin({site: Site.LABS_ACTOR,
   name: 'Actor', category: 'company', companyDomains:
   ['labs.actor']})`; `createHttpClient` GETs: careers shell →
   `main.{hash}.js` → chunk map → chunks, stopping at the first chunk
   containing the jobs-array anchor.
3. Array → `JobPostDto`: balanced-bracket slice + top-level split +
   per-key scalar/array extraction (never `eval`); `team` →
   `department`; `location` qualifier tail stripped before
   `parseLocationText`; `type` → `extractJobType` + raw
   `employmentType`; `summary`/`responsibilities`/`requirements`
   composed into `description`; `applyUrl` = per-team mailto with the
   site's own subject line.
4. Register in all four places: `site.enum.ts` (Phase 1705,
   `LABS_ACTOR = 'labs_actor'`), `packages/plugins/index.ts`
   (`LabsActorModule` in `ALL_SOURCE_MODULES`), `tsconfig.base.json`
   paths, `jest.config.js` `moduleNameMapper`.
5. Unit spec + fixtures (shell html, main-bundle map excerpt, careers
   chunk slice); run jest for the package, `tsc` typecheck,
   `lint:docs`; update `docs/index.md` + `docs/log.md`.

## Phases

- P1 scaffold + registration
- P2 service + parsing
- P3 tests + docs + CI

## Risks

- Chunk hashes rotate every deploy — resolved at fetch time from the
  live main bundle, never hardcoded.
- The array binding name is minified per build — anchored on the entry
  shape (`=[{id:"`), not the identifier.
- A deploy could move roles out of the chunk (e.g. to a CMS) → plugin
  returns the `empty` diagnostic rather than a crash.
