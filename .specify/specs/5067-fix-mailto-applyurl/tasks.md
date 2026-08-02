# Tasks 5067 — Stop putting `mailto:` in `applyUrl`

- [x] buildcover: drop `applyUrl: mailto:${emails[0]}`; keep `emails`.
- [x] desktopmetal: drop `applyUrl: mailto:${emails[0]}`; keep `emails`.
- [x] notion-pages: drop `applyUrl: mailto:${emails[0]}`; keep `emails`.
- [x] niceboard: `buildApplyUrl` returns real `apply_url` or null (no mailto).
- [x] niceboard: add `buildEmails` (union `apply_email` + description emails, de-duped).
- [x] Flip buildcover/desktopmetal/notion specs to assert `applyUrl == null`.
- [x] Add `niceboard.apply.spec.ts` (fixture-mocked) for the three apply cases.
- [x] Focused jest green for all four packages (24 + 3 tests).
- [x] `tsc --noEmit` per package clean (baseline TS6059 noise only).
- [x] docs/index.md + docs/log.md updated.
