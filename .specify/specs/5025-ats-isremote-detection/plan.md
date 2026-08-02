# Plan: 5025 — Workday `isRemote` detects `Remote_*` locations

| Field | Value |
| --- | --- |
| Spec ID | 5025 |
| Status | implemented |
| Created | 2026-06-28 |

## Phases

1. **Fix** — in `packages/plugins/source-ats-workday/src/workday.service.ts`,
   map each location label through `_`→space + whitespace-collapse before
   `parseLocationList`.
2. **Test** — add a workday service test for a `Remote_USA` location.
3. **Verify** — run the workday suites; typecheck the package.

## Packages touched

- `packages/plugins/source-ats-workday` (src + `__tests__`).

## Risks

- Over-normalizing a meaningful underscore in a place name. Mitigation:
  underscores are not meaningful in workday place names; the map is a no-op
  except where `_` appears and only ever adds a word boundary.
