# Tasks: 5041 — source-ats-prismhr

| Field | Value |
| --- | --- |
| Spec ID | 5041 |
| Slug | source-ats-prismhr |
| Status | implemented |

## Task list

- [x] T1 — Gather tenants (5 live boards) and probe the PrismHR / HiringThing
  architecture: board `data-react-props` on `JobFiltersContainer`, detail
  JSON-LD + `ApplyButtonGroup` react-props; verify ground-truth counts
  (15 / 1 / 6 / 6 / 1 = 29)
- [x] T2 — Register `Site.PRISMHR = 'prismhr'` and scaffold the package
  (`packages/plugins/source-ats-prismhr/`); wire the four registration points
  (enum, `packages/plugins/index.ts`, `tsconfig.base.json`, `jest.config.js`)
- [x] T3 — `prismhr.constants.ts` (host suffix, URL builders, headers, caps,
  title/remote regexes) + `prismhr.types.ts` (`PrismhrListItem`,
  `PrismhrDetailData`, `PrismhrBoardProps`, `PrismhrDetailTableProps`)
- [x] T4 — `prismhr.service.ts`: board react-props parse (Cheerio, invert
  locations/categories maps, remotePositions set) + detail fan-out via the
  shared `parseJobPostingLd` extractor and `ApplyButtonGroup` react-props;
  department, compensation, structured location, remote, company name
- [x] T5 — Mocked-HTTP unit tests (`prismhr.service.spec.ts`): board parse,
  enumeration, location map, remote (3 sources), department (2 sources),
  compensation (yearly + hourly), de-dupe, resultsWanted, unreachable board,
  slug resolution, description formatting, emails, company name, JSON-LD-only
  role (20 unit tests)
- [x] T6 — Update `docs/index.md`, `docs/log.md`, `docs/questions.md`
