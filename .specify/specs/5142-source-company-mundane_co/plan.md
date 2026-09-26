# Plan: 5142 — source-company-mundane_co

## Phases

1. Scaffold `packages/plugins/source-company-mundane_co/` (package.json,
   tsconfig.json, index.ts, module, constants, types, service) — model on
   `source-company-power_us` structure.
2. Implement fetch + parse:
   - `fetchBundle(html)` — `/src="(\/assets\/[^"]+\.js)"/` on the `/join-us`
     shell → absolute bundle URL.
   - `parseBundleJobs(bundle)` — entry-shape regex over the bundle;
     JS-string unescape (`\\"`, `\\'`, `\\n`, `\\uXXXX`, `\\/`).
   - `toJobPost(entry)` — ids, LinkedIn query-strip, `parseLocationText`,
     `category` → `department`.
   - `fetchAirtableDescriptions(jobs)` — `BrowserPool.getPage({stealth,
     proxy})`, sequential renders of Airtable URLs, selector-list +
     longest-paragraph fallback inside `page.evaluate`; per-job failure
     leaves the job emitted sans description.
3. Register the plugin in the four places (enum, index, tsconfig paths,
   jest moduleNameMapper) — Phase 1699 comment.
4. Unit tests + fixture bundle slice.
5. Docs (index.md row + log.md entry), lint/typecheck, PR to `develop`.

## Packages touched

- `packages/plugins/source-company-mundane_co/` (new)
- `packages/models/src/enums/site.enum.ts`
- `packages/plugins/index.ts`
- `tsconfig.base.json`, `jest.config.js`
- `.specify/specs/5142-source-company-mundane_co/`, `docs/index.md`,
  `docs/log.md`

## Risks

- Bundle restructure: the array is build output — mitigated by matching the
  field shape (title/category/location/url) rather than the variable name,
  and `empty` diagnostics if the shape disappears.
- Airtable DOM: shared-form markup is not a contract — the selector list +
  longest-paragraph fallback tolerates renames; failure degrades to
  description-less rows, never dropped jobs.
- Board staleness: entries ship with the site bundle, so rows reflect the
  last deploy — inherent, documented.
