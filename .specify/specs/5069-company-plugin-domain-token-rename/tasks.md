# Tasks: 5069 — Company-plugin domain-derived `Site` token rename

- [x] T1 — Rename the 6 plugin dirs + `src`/`__tests__` files + token-prefixed fixtures.
- [x] T2 — Rewrite class/type/constant/package/job-id identifiers to the new tokens; preserve domain literals + display names.
- [x] T3 — Update `Site` enum key+value for the 6 plugins.
- [x] T4 — Update `packages/plugins/index.ts` imports + `ALL_SOURCE_MODULES`.
- [x] T5 — Update `tsconfig.base.json` path aliases + `jest.config.js` moduleNameMapper.
- [x] T6 — Run focused `jest` for the 6 packages (50 tests, all green).
- [x] T7 — `nx build api --skip-nx-cache` compiles the full registration.
- [x] T8 — Update `docs/index.md` + `docs/log.md`.
