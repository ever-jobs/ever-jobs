# Tasks: 5077 — Gusto-hosted headful browser + HTML parser fixes

- [ ] Pass `headful: true` to `BrowserPool.getPage` in `GustoHostedService.fetchRenderedHtml`.
- [ ] Fix `parseBoard` title extraction to prefer an `h1`–`h6` inside the posting anchor.
- [ ] Add HTML fallback to `parseDetail` for company, title, location, employment type, and description.
- [ ] Add `material.inc` and `naturaresources.com` board/detail fixtures.
- [ ] Add two fixture-based test cases covering both boards.
- [ ] Update `docs/index.md` and `docs/log.md`.
- [ ] Run `npx jest --testPathPatterns=source-ats-gusto-hosted` and `npx tsc --noEmit -p packages/plugins/source-ats-gusto-hosted/tsconfig.json`.
