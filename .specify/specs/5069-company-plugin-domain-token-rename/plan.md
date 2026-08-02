# Plan: 5069 — Company-plugin domain-derived `Site` token rename

| Field | Value |
| --- | --- |
| Spec ID | 5069 |
| Slug | company-plugin-domain-token-rename |
| Status | done |
| Owner | agent |
| Created | 2026-07-26 |
| Last updated | 2026-07-26 |
| Supersedes | (none) |
| Related specs | (none) |


## Phases

1. **Rename plugin packages** (6): `git mv` dir + `src/*.ts` + `__tests__/*.spec.ts` + token-prefixed fixtures to the new token.
2. **Rewrite identifiers** in each package: Pascal class/type names, `UPPER_` constant prefix, `Site.<KEY>` refs, import file-stems, package name, job-id prefix. Preserve real domain string literals and human display names.
3. **Registrations**: `packages/models/src/enums/site.enum.ts` (key + value), `packages/plugins/index.ts` (import + `ALL_SOURCE_MODULES`), `tsconfig.base.json` (path alias), `jest.config.js` (moduleNameMapper).
4. **Validate**: focused `jest` for the 6 packages; `nx build api` (no cache) for the full registration.

## Packages touched

- `packages/plugins/source-company-{flymotionus,vightaero,hyl_io,galadyne_io,framework_co,mara_inc}`
- `packages/models`, `packages/plugins/index.ts`, `tsconfig.base.json`, `jest.config.js`

## Risks

- The id token is a substring of its own domain (`flymotion`↔`flymotionus.com`, `galadyne`↔`galadyne.io`), so blind text replacement can corrupt domain literals — replacements are anchored (`/token.`, `` `token- ``, `source-company-token`, `Site.KEY`, `KEY_`) and every domain constant is verified after.
- Shared-root new tokens (`FRAMEWORK_CO`, `GALADYNE_IO`, `MARA_INC`) can double-suffix if a prefix rule re-matches — verified no `_CO_CO` / `_IO_IO` / `_INC_INC` remain.

## Out of scope

- Keeping any external domain-deriving consumer in sync with the rule + its hardcoded `divergent`/`nuro` exceptions (lives with that consumer, not this repo).