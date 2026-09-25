# Plan: 5135 — Source ATS plugin: Nodi (`source-ats-nodi_global`)

| Field | Value |
| --- | --- |
| Spec ID | 5135 |
| Status | implemented |
| Created | 2026-09-19 |

## Phases

1. **Plugin package** — `packages/plugins/source-ats-nodi_global/` with
   service/module/types/constants; `scrape()` issues two parallel GETs
   (offers list + company by-name) via `createHttpClient`, then maps each
   offer to `JobPostDto`.
2. **Registration** — `Site.NODI_GLOBAL`, `ALL_SOURCE_MODULES`,
   `tsconfig.base.json` paths, `jest.config.js` moduleNameMapper.
3. **Tests** — fixture JSON (live-captured offers + company) behind a mocked
   `createHttpClient`; covers mapping, company-name fallback, salary,
   filters, error paths.
4. Docs (`docs/index.md`, `docs/log.md`).

## Risks

- The `by-name` endpoint tolerates any slug spelling observed; a miss only
  costs `companyName`/`companyUrl` enrichment, not the job list.
- `magic_link` absent → falls back to the constructed
  `app.nodi.global/jobs/public/<id>` URL.
