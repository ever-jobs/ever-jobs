# Plan: 5066 — source-company-vight

| Field | Value |
| --- | --- |
| Spec ID | 5066 |
| Slug | source-company-vight |
| Status | done |
| Owner | agent |
| Created | 2026-07-15 |
| Last updated | 2026-07-15 |
| Supersedes | (none) |
| Related specs | (none) |


## Phases

1. **Scaffold plugin package** `packages/plugins/source-company-vight`
    - `package.json`, `tsconfig.json`, `src/{index,vight.module,vight.service,vight.constants,vight.types}.ts`
2. **Constants/types** — origin, careers URL, Cloudflare email-protection path, defaults; `VightOpening` (card) + `VightDetail` (detail) interfaces
3. **Service** — `IScraper.scrape`:
    - fetch `/join-us/` → `parseListing` (each `<article class="role">`: card `id` slug, `.role-title`, `.role-copy`, `.role-meta span` chips, apply link → detail URL or Cloudflare email)
    - fetch each real role's `/join-us/{slug}/` → `parseDetail` (`<h1>` title, `.meta` chips, every `<section>` → markdown, decoded apply email) — **only on-domain `vightaero.com` is fetched**
    - `classifyMeta` (a `City, ST` chip → location; a job-type chip → employment type; other chips ignored)
    - `decodeCfEmail` (Cloudflare `/cdn-cgi/l/email-protection#<hex>` → `join@vightaero.com`, drop `?subject=`)
    - `toJobPost` mapping (detail wins for title/location/type; `jobUrl` on-domain detail page / generalist `/join-us/`; `emails=[join@vightaero.com]`, `applyUrl` unset; `isRemote=false`; `compensation`/`datePosted` none)
    - `applyInput` (searchTerm/isRemote/jobType filters + offset/resultsWanted)
    - `Promise.allSettled` fan-out; per-role detail failure degrades to card-only fields
4. **Register in 4 places** — `Site.VIGHT`, `ALL_SOURCE_MODULES`, tsconfig path alias, jest `moduleNameMapper`
5. **Tests** — fixture-based unit tests over the captured `/join-us/` + three `/join-us/{slug}/` pages (fetch seam throws on any non-`vightaero.com` URL)
6. **Docs** — `docs/index.md`, `docs/log.md` (top)

## Packages touched

- `packages/plugins/source-company-vight` (new)
- `packages/models/src/enums/site.enum.ts`, `packages/plugins/index.ts`, `tsconfig.base.json`, `jest.config.js`
- `docs/*`

## Risks

- The apply email is Cloudflare-obfuscated; the plugin decodes the token rather than relying on plaintext. A malformed token degrades `emails` to `[]` while the rest of the role still populates.
- The detail `<h1>` can differ from the card title (GNC) — the detail title is used per the owner decision; the card title is the fallback when a detail page cannot be fetched.
- The generalist has no detail page and no location/employment meta; those fields stay null (not borrowed from the real roles).
- Bespoke hand-coded markup could drift on a redesign → the affected field degrades (description → null, or meta → null) and the role still emits with its card fields. Selectors validated against captured fixtures for all four roles.

## Dependencies

- None blocking. Reuses shared `parseLocationList` / `getJobTypeFromString` / `markdownConverter`. Standalone PR against `develop`.