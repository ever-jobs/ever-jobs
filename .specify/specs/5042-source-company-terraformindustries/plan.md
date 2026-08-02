# Plan: 5042 — source-company-terraformindustries

| Field | Value |
| --- | --- |
| Spec ID | 5042 |
| Slug | source-company-terraformindustries |
| Status | implemented |

## Phases

### Phase 1 — Registration + scaffold

- `Site.TERRAFORMINDUSTRIES = 'terraformindustries'` in
  `packages/models/src/enums/site.enum.ts`.
- New package `packages/plugins/source-company-terraformindustries/`
  (package.json, tsconfig.json,
  `src/{index,terraformindustries.module,terraformindustries.service,terraformindustries.constants}.ts`).
- Register in `packages/plugins/index.ts` (`ALL_SOURCE_MODULES`),
  `tsconfig.base.json` paths, `jest.config.js` moduleNameMapper.

### Phase 2 — Constants

- `terraformindustries.constants.ts`: careers URL, company name, careers heading,
  domain marker, default results / timeout / detail concurrency, and the
  `terraformIndustriesDocUrl(id)` / `terraformIndustriesDocExportUrl(id)`
  builders.

### Phase 3 — Service (scrape flow)

- `scrape()`: `fetchText(/)` → `parseRoles()` → `fetchDetails()` (bounded
  fan-out, deduped by docId) → map to `JobPostDto[]` → `applyInput()`.
- `parseRoles(html)`: slice the HTML at the `Careers` heading, Cheerio-load the
  remainder, collect `a[href*="docs.google.com/document/"]`, extract docId +
  title, de-dupe by title.
- `fetchDetails(client, roles)`: unique docIds only, `Promise.allSettled`
  batches of `TERRAFORMINDUSTRIES_DETAIL_CONCURRENCY`; a shared doc (e.g. the
  reused technician description) is fetched once.
- `parseDoc(text)`: locate the `terraformindustries.com` domain line; next
  non-empty line = location, remainder = description body (blank-line-collapsed).
- `toJobPost(role, detail)`: build id slug, canonical doc jobUrl, structured
  location via `parseLocationList`, `isRemote` / `workFromHomeType` from the
  parsed location, emails from the description.
- `applyInput(jobs, input)`: searchTerm / location / isRemote / jobType filters,
  then `offset` + `resultsWanted` slice.

### Phase 4 — Tests + docs

- Mocked-HTTP unit tests per the spec test plan.
- Update `docs/index.md`, `docs/log.md`, `docs/questions.md`.

## Packages touched

- `packages/models` (enum), `packages/plugins` (new package + index),
  `tsconfig.base.json`, `jest.config.js`, `.specify/specs/5042-*`, `docs/*`.

## Risks

- The home page is hand-maintained markup: the `Careers` heading scoping and the
  Google-Docs-link selector are the coupling points. If the section is
  restructured, `parseRoles` is where to adjust; failures degrade to an empty
  list rather than throwing.
- Google Docs export availability: individual failures degrade a role's
  enrichment to null (title + jobUrl still returned) rather than failing the run.
- Roles that share a Google Doc (a reused generic description) intentionally
  share `jobUrl` and description while keeping distinct titles/ids.
