# Tasks 5164

| Spec | 5164 — search-deadline-override |
| --- | --- |
| Package | apps/api |

- [ ] `configuration.ts`: `search.deadlineMaxMs` from `EVER_JOBS_SEARCH_DEADLINE_MAX_MS` (default 0 = uncapped).
- [ ] `jobs.controller.ts`: `deadline_ms` `@ApiQuery` + `@Query` param after `includeRawRaw`; `parseDeadlineMs` (non-numeric/negative → 400); ceiling check (max set → `0`/`>max` → 400); pass via options.
- [ ] `jobs.controller.ts`: cache-write guard — skip `cacheService.set` when `perSource.length === 1` and reason ∉ {`ok`, `empty`}.
- [ ] `jobs.service.ts`: `options.deadlineMs`; single-source 400 beside the `captureRaw` gate; `deadlineAt` uses override; warn text gains `?deadline_ms`.
- [ ] Tests — controller: absent→default, 0→disabled (max unset), 0→400 (max set), >max→400, multi-source→400, invalid→400, absent from `cacheParams`, cache-hit still served, failed single-source → no write, ok single-source → write, multi-source-with-failure → write.
- [ ] Tests — service: `deadlineMs` override lets a slow scrape finish; override produces the single-source 400.
- [ ] `npx jest` touched specs + `npx tsc --project tsconfig.typecheck.json --noEmit` + `npm run lint:docs`.
- [ ] `docs/index.md` row + `_Last revised_` footer; `docs/log.md` prepend.
