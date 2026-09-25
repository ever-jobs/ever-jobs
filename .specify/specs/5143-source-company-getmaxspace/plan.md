# Plan: 5143 — source-company-getmaxspace

| Field | Value |
| ----- | ----- |
| Spec ID | 5143 |
| Slug | source-company-getmaxspace |
| Status | Done |
| Owner | Devin (for MakeDeeply) |

## Phases

1. Scaffold `packages/plugins/source-company-getmaxspace/` — model on
   `source-company-tau-robotics` (cheerio-parse a static careers page).
2. Implement `GetMaxSpaceService.scrape`: `createHttpClient` GET of
   `getmaxspace.com/careers` → `cheerio` → each `a.career-jobs_cms-link`
   item → columns `is-1` title / `is-2` department / `is-3` employmentType /
   `is-4` location → `JobPostDto` (`id` from `/job/` hex suffix or `jk`
   param, slug fallback; `jobUrl` = Indeed href, `&amp;` decoded).
3. Register in the four places (enum Phase 1700, index, tsconfig paths,
   jest moduleNameMapper).
4. Unit tests + live-page HTML fixture.
5. Docs (index.md row + log.md entry), lint/typecheck, PR to `develop`.

## Packages touched

- `packages/plugins/source-company-getmaxspace/` (new)
- `packages/models/src/enums/site.enum.ts`
- `packages/plugins/index.ts`
- `tsconfig.base.json`, `jest.config.js`
- `.specify/specs/5143-source-company-getmaxspace/`, `docs/index.md`,
  `docs/log.md`

## Risks

- Webflow class renames on redesign — mitigated by `empty` diagnostics if
  the selectors yield nothing.
- Indeed href shape changes (`/job/{slug}-{hex}` vs `viewjob?jk=`) — both
  patterns handled, slug fallback covers anything else.
