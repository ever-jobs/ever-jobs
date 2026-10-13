# Plan: 5169 — source-company-buildnebula

| Field | Value |
| --- | --- |
| Spec ID | 5169 |
| Slug | source-company-buildnebula |
| Status | draft |
| Owner | agent |
| Created | 2026-10-03 |

## Phases

1. **Scaffold** `packages/plugins/source-company-buildnebula/`
   (`package.json`, `tsconfig.json`, `src/{index.ts,buildnebula.module.ts,
   buildnebula.service.ts,buildnebula.constants.ts,buildnebula.types.ts}`),
   modeled on `source-company-power_us` (single JSON endpoint → DTO map).
2. **Register** in the four places: `site.enum.ts`, `packages/plugins/index.ts`,
   `tsconfig.base.json` paths, `jest.config.js` moduleNameMapper.
3. **Implement** the service: one `createHttpClient` GET of
   `{origin}/api/careers/listings`, map `items[]` per the spec's contract,
   `applyInput` filtering (searchTerm/location/offset/resultsWanted).
4. **Tests** against the captured fixture; `jest`, `tsc`, `lint:docs`.
5. **Docs**: `docs/index.md` entry + `docs/log.md` line; commit, push, PR.

## Packages touched

- new: `packages/plugins/source-company-buildnebula`
- edit: `packages/models/src/enums/site.enum.ts`, `packages/plugins/index.ts`,
  `tsconfig.base.json`, `jest.config.js`, `docs/index.md`, `docs/log.md`

## Risks

- Endpoint is first-party and versioned (`policy_version: 3`); field names
  could shift — parsing is defensive (all fields optional, filters only apply
  when the field is present).
- `items` may include non-`public`/`takedown` entries in future — gated.
