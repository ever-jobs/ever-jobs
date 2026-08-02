# Plan: 5026 — Ashby `isRemote` reads structured `workplaceType`

| Field | Value |
| --- | --- |
| Spec ID | 5026 |
| Status | implemented |
| Created | 2026-06-28 |

## Phases

1. **Types** — add `workplaceType?: string | null` to `AshbyJob` in
   `ashby.types.ts`.
2. **Fix** — in `ashby.service.ts` `processJob`, derive `isRemote` from
   `workplaceType` (Remote only) with the boolean as fallback, and map
   `workplaceType` → `workFromHomeType` merged with the location-text value.
   Mirror the lever plugin's `workFromHomeTypeFromWorkplace` / `mergeWorkFromHomeType`
   helpers.
3. **Test** — add ashby service tests for Hybrid / Remote / no-workplaceType.
4. **Verify** — run the ashby suites; typecheck the package.

## Packages touched

- `packages/plugins/source-ats-ashby` (src + `__tests__`).

## Risks

- An unexpected `workplaceType` casing/value would map to none and fall back to
  the boolean. Mitigation: matching is case-insensitive; the boolean + location
  text remain as fallbacks, so detection never regresses below today's behaviour
  for non-Hybrid postings.
