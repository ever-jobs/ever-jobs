# Plan: 5024 — `datePosted` keeps the source local day (repo-wide)

| Field | Value |
| --- | --- |
| Spec ID | 5024 |
| Status | implemented |
| Created | 2026-06-28 |

## Phases

1. **Shared helper** — add `packages/common/src/converters/date-converter.ts`
   exporting `toDateOnly`; re-export from `converters/index.ts` (already barreled
   into `@ever-jobs/common`).
2. **Wire greenhouse** — import `toDateOnly` in
   `packages/plugins/source-ats-greenhouse/src/greenhouse.service.ts`; replace
   both `new Date(datePosted).toISOString().split('T')[0]` expressions
   (`processJob` public board + `processHarvestJob` Harvest API) with
   `toDateOnly(datePosted)`.
3. **Tests** — `packages/common/__tests__/date-converter.spec.ts` and a new case
   in `packages/plugins/source-ats-greenhouse/__tests__/greenhouse.service.spec.ts`.
4. **Repo-wide codemod** — a one-off TS-compiler-API script rewrites every
   `…toISOString().split('T')[0]` chain (inline and the bespoke-helper variant
   reached through a `const d = new Date(EXPR)` binding) to `toDateOnly(EXPR)`
   and adds the `@ever-jobs/common` import. Hand-finish the `Date`-typed helpers
   (`source-bdjobs`, `source-naukri`, `source-ats-workday`), remove the two
   duplicate private `toDateOnly` methods (`source-jsonld`,
   `source-ats-workatastartup`), and add `?? undefined` where a plugin's local
   `datePosted` is typed `string | undefined`.

## Packages touched

- `@ever-jobs/common` (new helper + test)
- `@ever-jobs/source-ats-greenhouse` (wire + test)
- 228 source-plugin packages (codemod + hand-finish) — all date-only
  normalization now delegates to `@ever-jobs/common`

## Risks

- **Behaviour change**: offset timestamps now resolve to a different (correct)
  calendar day than before. This is the intended fix; it only moves the day for
  postings whose UTC day differed from their local day.
- **Bare-date / `Z` inputs**: unchanged (bare date passes through; `Z` keeps its
  UTC day, identical to old behaviour).
- **Large mechanical diff**: 228 files. Mitigated by an AST codemod (no hand
  edits to the bulk), a whole-graph typecheck, and the fact that `toDateOnly` is
  output-identical to the old expression for `Z`/bare-date/epoch/`Date` inputs —
  it only changes the offset-string case that was broken.
- **Bespoke helpers**: the codemod passes the original *string* (not an
  intermediate `Date`) to `toDateOnly`, so the offset-preserving fix actually
  takes effect rather than being a no-op.

## Verification

- `npm run build` (nx whole-graph typecheck across all plugins) — **green**
- `npx jest packages/common packages/plugins/source-ats-greenhouse …` (both
  code families: inline, bespoke-helper, RSS, jsonld/workatastartup) — **green**
- `npm run lint:docs`
- (`npm run lint` is a no-op in this repo — no eslint config / lint targets.)
