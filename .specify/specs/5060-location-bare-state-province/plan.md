# Plan: 5060 — Opt-in bare state/province classification

| Field | Value |
| --- | --- |
| Spec ID | 5060 |
| Slug | location-bare-state-province |
| Status | done |
| Owner | agent |
| Created | 2026-07-14 |
| Last updated | 2026-07-14 |
| Supersedes | (none) |
| Related specs | (none) |


## Phases

1. **Options type.** Add exported `ParseLocationOptions { allowBareStateProvince?:
   boolean }` to `packages/common/src/utils/location-parser.ts` (re-exported via
   the `utils` barrel). Generic name reserves room for future non-US
   subdivisions; this spec is US-only.
2. **Thread the option.** Add the optional `options?: ParseLocationOptions`
   parameter to `parseLocationText` and `parseLocationList`; `parseLocationList`
   forwards it to `parseLocationText`.
3. **Bare-state branch.** In `parseLocationText`, after the existing `City, ST`
   match and before the `city` fallback, when `options.allowBareStateProvince`
   is set and the geographic text has no comma, call the existing
   `normalizeUsState()`; on a hit return a state-only `LocationDto`.
4. **Tests.** New `describe('allowBareStateProvince opt-in')` block in
   `packages/common/__tests__/location-parser.spec.ts` (default-off regression,
   name/code promotion, `City, ST` untouched, non-state/province negatives).
5. **Docs.** `docs/index.md` (5060 row), `docs/log.md` (top entry).

## Packages touched

- `packages/common` only (parser + its tests). No plugin, no dependency, no
  registration points (shared-utility change).

## Risks

- **Behaviour drift for existing callers.** Mitigated: the branch is gated behind
  an explicit flag defaulting to false and runs only after the `City, ST` path,
  so the full `packages/common` suite stays green with no expectation changes.
- **Over-promotion of ambiguous words** (`"Virginia"` the MN city, `"Georgia"`
  the country). Accepted and documented: promotion happens **only** for callers
  that opt in, i.e. sources known to emit a bare state — never globally.

## Rollback

Revert the single parser change (options type + parameter + the guarded branch);
the `City, ST` and `city`-fallback paths are independent and unaffected.