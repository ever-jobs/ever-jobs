# Plan: 5041 — source-ats-prismhr

| Field | Value |
| --- | --- |
| Spec ID | 5041 |
| Slug | source-ats-prismhr |
| Status | implementing |

## Phases

### Phase 1 — Registration + scaffold

- `Site.PRISMHR = 'prismhr'` in `packages/models/src/enums/site.enum.ts`.
- New package `packages/plugins/source-ats-prismhr/` (package.json, tsconfig.json,
  `src/{index,prismhr.module,prismhr.service,prismhr.constants,prismhr.types}.ts`).
- Register in `packages/plugins/index.ts` (`ALL_SOURCE_MODULES`),
  `tsconfig.base.json` paths, `jest.config.js` moduleNameMapper.

### Phase 2 — Constants and types

- `prismhr.constants.ts`: `PRISMHR_HOST_SUFFIX` (`.prismhr-hire.com`),
  `prismhrBoardUrl(slug)` / `prismhrDetailUrl(slug, id)` builders, headers,
  timeout / results / concurrency caps, `PRISMHR_TITLE_COMPANY_REGEX`,
  `PRISMHR_REMOTE_REGEX`.
- `prismhr.types.ts`: `PrismhrListItem` (board row), `PrismhrDetailData`
  (merged detail fields), `PrismhrBoardProps` (JobFiltersContainer payload),
  `PrismhrDetailTableProps` (ApplyButtonGroup `jobObj.table`).

### Phase 3 — Service (scrape flow)

- `scrape()`: resolve slug → `fetchText(/)` → `parseBoard()` → slice to
  `resultsWanted` → `fetchDetails()` (bounded fan-out) → map to `JobPostDto[]`.
- `parseBoard(html, slug)`: Cheerio — read the JobFiltersContainer
  `data-react-props`; build `titles[]` list, invert `locations` (state→city→ids)
  and `categories` (category→ids) into id-keyed maps, `remotePositions` set;
  de-dupe by id; pull company name from `<title>` / `og:title`.
- `fetchDetails(client, slug, items)`: `Promise.allSettled` batches, one detail
  fetch per role, `parseJobPostingLd(html)[0]` + `ApplyButtonGroup` react-props
  → `PrismhrDetailData`.
- `toJobPost(item, slug, company, detail, format)`: merge board + detail →
  `JobPostDto`.

### Phase 4 — Field enrichment

- `buildLocation()`: detail structured location first (JSON-LD, then
  react-props `location_info`), board `locations` map fallback, bare `Remote`
  marker last.
- `isRemote`: detail react-props `remote` OR board `remotePositions`, text
  heuristic on title / location fallback.
- compensation: react-props `min_salary` / `max_salary` amount + currency,
  `pay_frequency` → `getCompensationInterval`.
- company name: detail `hiringOrganization` / react-props `company_name`, board
  `<title>` fallback, de-slugified slug last.

### Phase 5 — Tests

- Mocked-HTTP unit tests covering every path (board react-props, enumeration,
  location map, remote from remotePositions / react-props / text, department
  from categories / react-props, compensation yearly + hourly, de-dupe,
  resultsWanted, unreachable board, slug resolution, description formatting,
  emails, company name, JSON-LD-only role).

### Phase 6 — Docs

- Update `docs/index.md`, `docs/log.md`, `docs/questions.md`.

## Risks

- **Board react-props structure change**: parsing relies on the
  `HiringThing.Components.JobFiltersContainer` `data-react-props` shape.
  Mitigated: JSON is parsed defensively; an unrecognised board yields `[]`.
- **Detail react-props / JSON-LD absent**: a role may lack one or both blocks.
  Mitigated: JSON-LD and react-props are independent sources; the role is still
  emitted from board fields if either is missing.
- **Salary object shape**: `min_salary` / `max_salary` are objects that are
  often empty (`{}`) but carry `amount` + `currency` when set. Mitigated:
  amount extraction is defensive across candidate keys; empty → null.
- **Tenant migration**: a tenant can move off PrismHR. Mitigated:
  `maxRedirects: 0` + degrade to `[]`.
- **Large boards**: all roles render in one payload. Mitigated: slice to
  `resultsWanted` before the detail fan-out; concurrency-capped batches.
