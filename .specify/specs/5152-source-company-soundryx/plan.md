# Plan: 5152

| Field | Value |
| ----- | ----- |
| Spec ID | 5152 |
| Slug | source-company-soundryx |
| Status | Done |
| Owner | Devin (for MakeDeeply) |

## Approach

Two-stage static-HTML company plugin (index + detail pages, same shape
as `source-company-atlasspace`):

1. Scaffold `packages/plugins/source-company-soundryx/` — package.json,
   tsconfig, `src/{index,module,service,constants,types}.ts`,
   `__tests__/`.
2. `soundryx.service.ts` — `@SourcePlugin({site: Site.SOUNDRYX, name:
   'Soundryx', category: 'company', companyDomains:
   ['soundryx.com']})`; `createHttpClient` GETs the careers index, then
   each `a.srx-tile.is-link` detail page.
3. Detail page → `JobPostDto`: `h1` title (parens meta tail dropped),
   `<strong>Location</strong>` line → `parseLocationText` +
   `workFromHomeType: 'On Site'` when `(onsite)`, `.vp-doc` minus
   `section.footnotes` → `htmlToPlainText` description,
   `h2#compensation` → `resolveCompensation({text})`,
   `h2#apply-now` → `data-cfemail` XOR decode → mailto `applyUrl`.
4. Register in all four places: `site.enum.ts` (Phase 1706,
   `SOUNDRYX = 'soundryx'`), `packages/plugins/index.ts`
   (`SoundryxModule` in `ALL_SOURCE_MODULES`), `tsconfig.base.json`
   paths, `jest.config.js` `moduleNameMapper`.
5. Unit spec + fixtures (live index + all 3 live detail pages); run
   jest for the package, `tsc` typecheck, `lint:docs`; update
   `docs/index.md` + `docs/log.md`.

## Phases

- P1 scaffold + registration
- P2 service + parsing
- P3 tests + docs + CI

## Risks

- `data-cfemail` is a stable Cloudflare encoding (first byte XOR) but
  if the site drops it, `applyUrl` falls back to the detail page.
- Tile hrefs are relative — resolved against the page origin.
- A restructure of `.vp-doc` → `empty` diagnostic, not a crash.
