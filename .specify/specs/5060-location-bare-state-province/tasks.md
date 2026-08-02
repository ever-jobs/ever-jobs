# Tasks: 5060 — Opt-in bare state/province classification

- [x] T01 Add exported `ParseLocationOptions { allowBareStateProvince?: boolean }`
      to `location-parser.ts` (re-exported via the `utils` barrel).
- [x] T02 Add `options?: ParseLocationOptions` to `parseLocationText` and
      `parseLocationList`; forward it from the list to the text parser.
- [x] T03 Add the guarded bare-state branch to `parseLocationText` (flag on +
      no comma → `normalizeUsState()` → state-only `LocationDto`), placed after
      the `City, ST` match and before the `city` fallback.
- [x] T04 Add the `describe('allowBareStateProvince opt-in')` block to
      `location-parser.spec.ts` (default-off regression, name/code promotion,
      `City, ST` untouched, non-state/province negatives).
- [x] T05 Run `npx jest packages/common` — all green; `tsc --noEmit -p
      packages/common/tsconfig.json` clean.
- [x] T06 Docs: `docs/index.md` (5060 row), `docs/log.md` (top entry).
- [x] T07 Diff/privacy scan (no private refs, no session URLs); commit + PR into
      `develop`.
