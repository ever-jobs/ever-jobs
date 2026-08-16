# Spec: 5077 — Gusto-hosted headful browser + HTML parser fixes

| Field          | Value                              |
| -------------- | ---------------------------------- |
| Spec ID        | 5077                               |
| Slug           | gusto-hosted-headful-parsing       |
| Status         | in-progress                        |
| Owner          | agent                              |
| Created        | 2026-08-04                         |
| Last updated   | 2026-08-04                         |
| Supersedes     | (none)                             |
| Related specs  | 5076, 5054                         |

## 1. Problem Statement

`source-ats-gusto-hosted` returns 0 jobs for `material.inc` and `naturaresources.com` boards.

Two independent failures:

1. `BrowserPool` fetches the board with an ephemeral headless context, which Cloudflare challenges; the returned HTML has no `/postings/` links.
2. Even with a rendered page, the parser has small bugs:
   - `parseBoard` uses `$(el).text()` on the posting anchor, so the title is polluted with location text, SVG alt text, and employment type.
   - `parseDetail` only reads JSON-LD; live Gusto posting pages no longer embed a `JobPosting` `application/ld+json` block, so every posting gets an empty description and falls back to the slug-derived title.

## 2. Goals

- Use the new `BrowserPool` headful/persistent-context opt-in for Gusto-hosted fetches.
- Fix `parseBoard` title extraction to prefer a heading inside the posting anchor.
- Add an HTML fallback in `parseDetail` for when JSON-LD is absent.
- Add fixture-based tests covering the `material.inc` and `naturaresources.com` boards.

## 3. Non-Goals

- No fetch1 coupling, `file://` cache paths, or `companyUrl` hacks.
- No changes to `ScraperInputDto` or to other plugins.
- No attempt to solve CAPTCHA / interactive Cloudflare challenges automatically.
- No real user Chrome profile.

## 4. Changes

1. `GustoHostedService.fetchRenderedHtml` requests `BrowserPool.getPage({ ..., headful: true })`.
2. `GustoHostedService.parseBoard` extracts title from the first `h1`–`h6` inside the posting anchor, falling back to anchor text and then slug-derived title.
3. `GustoHostedService.parseDetail` falls back to HTML extraction when `parseJobPostingLd` returns nothing, reading company, title, location, employment type, and description from the rendered posting page.
4. Snapshot test fixtures are added for `material.inc` and `naturaresources.com` boards plus one detail page each.

## 5. Test Plan

- `npx jest --testPathPatterns=source-ats-gusto-hosted` passes, including the two new fixture tests.
- `npx tsc --noEmit -p packages/plugins/source-ats-gusto-hosted/tsconfig.json` is clean.
