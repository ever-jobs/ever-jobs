# Plan: 5158

| Field | Value |
| --- | --- |
| Spec | 5158 |
| Title | Source Company Plugin: Werco Manufacturing (wercomfg.com) |
| Status | Approved |

## Approach

New self-contained package `packages/plugins/source-company-wercomfg`:

- `src/wercomfg.constants.ts` — company name, origin, careers path, detail-link
  selector/pattern, apply mailto, timeout.
- `src/wercomfg.types.ts` — internal row types (detail link + extracted fields).
- `src/wercomfg.service.ts` — `WercoMfgService implements IScraper`:
  1. `fetchJobs` — build `createHttpClient`, GET the index (input.companyUrl or
     the default careers URL), collect `/careers/{slug}` links via Cheerio,
     fan out `Promise.allSettled` detail GETs, parse each page.
  2. `parseDetail(html, fallbackUrl)` — `extractLdJsonBlocks` → first
     `JobPosting` node → `jobPostingLdFromNode(node)` for the normalised
     fields, plus raw `identifier`, `industry`, `occupationalCategory`,
     `workHours` read straight off the node.
  3. `toJobPost` — `wercomfg-{slug}` id, `LocationDto` from the structured
     address, `jobPostingLdToCompensation` (null today — published when the
     site adds `baseSalary`), description via `descriptionFormat`
     (`htmlToPlainText` default, `markdownConverter` for MARKDOWN, raw for
     HTML) with an industry/category/shift line appended.
  4. `applyInput` — `searchTerm` (title/description/location city+state),
     `offset`, `resultsWanted`.
- `src/wercomfg.module.ts`, `src/index.ts`, `package.json`, `tsconfig.json`.

## Registration (four places)

- `packages/models/src/enums/site.enum.ts` — `WERCOMFG = 'wercomfg'` under a
  Phase 1712 comment.
- `packages/plugins/index.ts` — `WercoMfgModule` import + `ALL_SOURCE_MODULES`.
- `tsconfig.base.json` — `@ever-jobs/source-company-wercomfg` path alias.
- `jest.config.js` — matching `moduleNameMapper` entry.

## Tests

- `__tests__/wercomfg.service.spec.ts` with captured fixtures
  (`fixtures/careers.html` index + two `detail-*.html` pages):
  - scrapes the fixture index → one job per detail link
  - title / `datePosted` / `jobType` / location city+state from JSON-LD
  - `id`/`atsId` from `identifier.value`
  - `jobUrl`/`applyUrl` values
  - `searchTerm` filter, `offset`/`resultsWanted` slice
  - detail fetch failure tolerated (`allSettled`)
  - index with no detail links → `empty` diagnostics
- Unit tests stub the HTTP client; live verification runs the service against
  the real site once.

## Risks

- The site could drop or rename the JSON-LD block — the service degrades to
  `empty` diagnostics rather than throwing.
- `identifier.value` could diverge from the URL slug — the URL slug is the
  fallback.

## Docs

- `.specify/specs/5158-source-company-wercomfg/{spec,plan,tasks}.md` (this).
- `docs/index.md` spec-table row + `_Last revised_` footer.
- `docs/log.md` entry.
