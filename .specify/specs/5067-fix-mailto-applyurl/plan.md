# Plan 5067 — Stop putting `mailto:` in `applyUrl`

| Field | Value |
| --- | --- |
| Spec ID | 5067 |
| Slug | fix-mailto-applyurl |
| Status | done |
| Owner | agent |
| Created | 2026-07-15 |
| Last updated | 2026-07-15 |
| Supersedes | (none) |
| Related specs | (none) |


## Phases

1. Company plugins — drop the `applyUrl: mailto:...` line; keep `emails`.
    - packages/plugins/source-company-buildcover/src/buildcover.service.ts
    - packages/plugins/source-company-desktopmetal/src/desktopmetal.service.ts
    - packages/plugins/source-notion-pages/src/notion.service.ts
2. Niceboard — `buildApplyUrl` returns real `apply_url` or null; add `buildEmails`
   (union `apply_email` + `extractEmails(description)`).
    - packages/plugins/source-ats-niceboard/src/niceboard.service.ts
3. Tests — flip the three company specs to `applyUrl == null`; add
   `niceboard.apply.spec.ts` (fixture-mocked HTTP client).
4. Docs + Spec-Kit — this spec/plan/tasks; `docs/index.md`; `docs/log.md`.

## Files touched

- 4 service files (src)
- 3 existing specs updated + 1 new spec (tests)
- docs/index.md, docs/log.md
- .specify/specs/5067-fix-mailto-applyurl/{spec,plan,tasks}.md

## Risks

- A downstream consumer that read the apply address only from `applyUrl` would no
  longer see it for these plugins. Mitigation: the address is on `emails` (the
  established field); niceboard's `applyUrl` still resolves to the real on-board
  `jobUrl`, so it is never null there.

## Dependencies

- Shared `extractEmails` from `@ever-jobs/common` (already used).
- No new dependency; no registration change (no new Site/module).