# Plan: 5140 — `source-company-tau-robotics`

| Field | Value |
| --- | --- |
| Spec ID | 5140 |
| Slug | source-company-tau-robotics |
| Status | implemented |
| Owner | agent |
| Created | 2026-09-23 |

## Phases

1. Scaffold `packages/plugins/source-company-tau-robotics/`
   (`package.json`, `tsconfig.json`, `src/index.ts`,
   `tau-robotics.module.ts`, `tau-robotics.service.ts`,
   `tau-robotics.constants.ts`, `tau-robotics.types.ts`).
2. Service: `createHttpClient` fetch of `careers.html` + `apply.js`;
   cheerio parse of role anchors; JS-literal parser for `ROLES`; map to
   `JobPostDto`.
3. Register: `site.enum.ts` (`TAU_ROBOTICS = 'tau-robotics'`),
   `packages/plugins/index.ts` `ALL_SOURCE_MODULES`,
   `tsconfig.base.json` paths, `jest.config.js` `moduleNameMapper`.
4. Unit tests with fixture files under `__tests__/fixtures/`.
5. Docs: `docs/index.md` row, `docs/log.md` entry.

## Risks

- `ROLES` literal parse: single-quoted strings may contain escapes
  (`\'`). Parser handles escapes; malformed literal → warn + emit rows
  without descriptions.
- `role__meta` format changes (fewer `·` segments) → emit what's
  parseable, never throw on a single row.
