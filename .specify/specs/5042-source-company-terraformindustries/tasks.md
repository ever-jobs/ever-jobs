# Tasks: 5042 — source-company-terraformindustries

| Field | Value |
| --- | --- |
| Spec ID | 5042 |
| Slug | source-company-terraformindustries |
| Status | implemented |

## Task list

- [x] T1 — Recon `terraformindustries.com`: confirm no third-party ATS; the
  home page carries a `Careers` section of `<a>` links to Google Docs; verify
  the Google Doc plain-text export endpoint
  (`/document/d/{id}/export?format=txt`) returns the header (company, title,
  domain, location) + description body over plain HTTP
- [x] T2 — Register `Site.TERRAFORMINDUSTRIES = 'terraformindustries'` and
  scaffold the package
  (`packages/plugins/source-company-terraformindustries/`); wire the four
  registration points (enum, `packages/plugins/index.ts`,
  `tsconfig.base.json`, `jest.config.js`)
- [x] T3 — `terraformindustries.constants.ts` (careers URL, company name,
  careers heading, domain marker, results/timeout/concurrency caps, doc URL +
  export URL builders)
- [x] T4 — `terraformindustries.service.ts`: careers-section scoping + Google
  Docs link enumeration (Cheerio), deduped bounded-concurrency doc-export
  fan-out, header/body doc parse, structured location via `parseLocationList`,
  isRemote/workFromHomeType, emails, and the searchTerm/location/isRemote/
  jobType/offset/resultsWanted input handling
- [x] T5 — Mocked-HTTP unit tests
  (`terraformindustries.service.spec.ts`): module resolution + site value,
  enumeration + doc enrichment, heading scoping / non-doc-link exclusion,
  shared-doc single fetch, Remote isRemote, doc-failure degradation, empty
  careers list, searchTerm filter, offset/resultsWanted, home-page failure
  (10 unit tests)
- [x] T6 — Update `docs/index.md`, `docs/log.md`, `docs/questions.md`
