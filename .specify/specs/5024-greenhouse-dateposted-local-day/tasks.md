# Tasks: 5024 — `datePosted` keeps the source local day (repo-wide)

- [x] T1 — Add `toDateOnly` helper in `packages/common/src/converters/date-converter.ts`.
    - Acceptance: ISO string preserves leading `YYYY-MM-DD`; epoch/`Date` fall
      back to UTC day; `null`/`''`/invalid → `null`.
- [x] T2 — Re-export from `packages/common/src/converters/index.ts`.
    - Acceptance: `import { toDateOnly } from '@ever-jobs/common'` resolves.
- [x] T3 — Wire `source-ats-greenhouse` public-board path (`processJob`,
      `first_published`) onto `toDateOnly`.
    - Acceptance: no `toISOString().split('T')[0]` left on that path.
- [x] T4 — Wire `source-ats-greenhouse` Harvest path (`opened_at`) onto
      `toDateOnly`.
    - Acceptance: no `toISOString().split('T')[0]` left on that path.
- [x] T5 — Add `packages/common/__tests__/date-converter.spec.ts`.
    - Acceptance: offset, bare-date, `Z`, epoch/`Date`, and null/invalid cases
      green.
- [x] T6 — Add greenhouse service test for an evening offset timestamp.
    - Acceptance: `first_published: 2026-04-20T22:32:33-04:00` → `datePosted`
      `2026-04-20`.
- [x] T7 — Typecheck both packages and run the two suites green.
- [x] T8 — Update `docs/index.md` (spec row + footer) and `docs/log.md` (top
      entry); `npm run lint:docs` passes.
- [x] T9 — Repo-wide codemod: route every `…toISOString().split('T')[0]` chain
      (inline + bespoke-helper variants) through `toDateOnly`, adding the
      `@ever-jobs/common` import.
    - Acceptance: 0 `toISOString().split('T')[0]` left in plugin `src/` (tests
      excluded); 228 files delegate to the shared helper.
- [x] T10 — Hand-finish the `Date`-typed helpers (`source-bdjobs`,
      `source-naukri`, `source-ats-workday`) and remove the duplicate private
      `toDateOnly` methods in `source-jsonld` + `source-ats-workatastartup`.
    - Acceptance: no per-plugin date-only helper duplicates the shared logic.
- [x] T11 — Resolve `string | undefined` `datePosted` locals (~40 RSS plugins)
      with `?? undefined`; whole-graph `npm run build` typecheck green; targeted
      jest suites for both families green.
