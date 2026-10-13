# Plan: 5155

| Field | Value |
| ----- | ----- |
| Status | Done |
| Spec | `.specify/specs/5155-source-company-xlight/spec.md` |
| Affected packages | `source-company-xlight` (new), `models` (enum), `plugins` (registry), root tsconfig + jest config |

## 1. Approach

One static GET of the Webflow careers page.

1. `fetchJobs` — `client.get` the careers page (`input.companyUrl`
   override), `cheerio.load`, `parseCareersPage` → `XlightJobRow[]`
   `{title, labels, applyHref}`.
2. `parseCareersPage` — each `div.careers-item.w-dyn-item`: title from
   `h3.job-item-title`; `div.job-item-info-label` texts minus the `|`
   separators → `labels`; `a.job-item-btn` href → `applyHref`.
3. `toJobPost` — LinkedIn id via `/jobs/view/(\d+)` on `applyHref`
   (title-slug fallback); `splitLabels` → department (first), type
   (first middle label that isn't a work mode), work mode
   (`remote|hybrid|on-?site` → `Remote`/`Hybrid`/`On Site`), location
   (last, through `parseLocationText`); `jobType` via `extractJobType` on
   de-hyphenated type text.
4. `jobUrl` = careers page; `jobUrlDirect`/`applyUrl` = the LinkedIn URL.
5. `applyInput` — `resultsWanted`/`offset`/`searchTerm`/`location`.

## 2. Files

- `src/xlight.constants.ts`, `src/xlight.types.ts`,
  `src/xlight.service.ts`, `src/xlight.module.ts`, `src/index.ts`,
  `package.json`, `tsconfig.json`.
- `__tests__/fixtures/careers.html` (live page).
- `__tests__/xlight.service.spec.ts`.
- Registration: `site.enum.ts` (`XLIGHT`, Phase 1709),
  `plugins/index.ts`, `tsconfig.base.json`, `jest.config.js`.
- Docs: `docs/index.md` row, `docs/log.md` entry.

## 3. Risks

- **Label order**: the meta line has no per-label semantics — dept/type/
  mode/location is positional. The split treats the first label as
  department, the last as location, and classifies middles by pattern,
  so a reordered or extra label degrades rather than misfiling.
- **Apply href shape**: ids come from `/jobs/view/{id}`; a non-LinkedIn or
  malformed href falls back to the title slug so a card never drops.
