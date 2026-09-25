# Spec: 5138 — Eightfold PCSX search endpoint fallback (`source-ats-eightfold`)

| Field | Value |
| --- | --- |
| Spec ID | 5138 |
| Slug | eightfold-pcsx-endpoint-fallback |
| Status | implemented |
| Owner | agent |
| Created | 2026-09-23 |

## Tasks

- [x] Add `unwrapPositionsAndCount(body)` helper to
      `eightfold.service.ts`: accepts `{positions, count}` (top level)
      or `{data: {positions, count}}` (PCSX); returns `null` for
      non-object bodies and objects lacking both payload markers.
      Acceptance: `{message: 'Not authorized for PCSX'}` and HTML
      strings return `null`; `{positions: [], count: 0}` returns a
      payload.
- [x] Rework `fetchPage` to iterate endpoints — resolved endpoint
      first, then `EIGHTFOLD_JOBS_PATH`, then
      `EIGHTFOLD_PCSX_SEARCH_PATH` — returning the first usable payload
      and caching the winning path on `this.jobsPath` so later pages
      reuse it.
      Acceptance: gated tenant pays one doomed request per run, not
      per page.
- [x] Add `__tests__/eightfold.endpoints.spec.ts` with a mocked
      `createHttpClient` covering: primary-works no-fallback,
      gated→PCSX unwrap, HTML→PCSX, empty-valid no-fallback, and
      resolved-endpoint reuse across pages.
- [x] Run scoped verification: jest on `source-ats-eightfold`, plus
      `tsc --noEmit` over the package via `tsconfig.typecheck.json`.
- [x] Update `docs/index.md` row + `docs/log.md` entry (newest at top);
      conventional commit; PR to `develop`.
