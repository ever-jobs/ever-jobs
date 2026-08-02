# Tasks: 5054 — source-ats-gusto-hosted

| Field | Value |
| --- | --- |
| Spec ID | 5054 |
| Slug | source-ats-gusto-hosted |
| Status | implemented |

## Task list

- [x] T1 — Confirm the target: Gusto-hosted multi-tenant boards
  (`jobs.gusto.com/boards/<slug>` + `/postings/<postingSlug>`), distinct from
  `source-company-gusto` (Gusto, Inc.'s own Greenhouse-backed careers). Root
  cause: an upstream harvesting pipeline labelled hosted boards with the `gusto`
  host token, colliding with `Site.GUSTO` (the employer).
- [x] T2 — Register `Site.GUSTO_HOSTED = 'gusto_hosted'` and scaffold the package
  (`packages/plugins/source-ats-gusto-hosted/`); wire the four registration
  points (enum, `packages/plugins/index.ts`, `tsconfig.base.json`,
  `jest.config.js`).
- [x] T3 — `gusto-hosted.constants.ts` (origin, board/posting URL builders, caps,
  posting-link + UUID + remote regexes, board-ready selector) +
  `gusto-hosted.types.ts` (`GustoHostedListItem`, `GustoHostedDetailData`).
- [x] T4 — `gusto-hosted.service.ts`: BrowserPool stealth fetch seams
  (Cloudflare, per Spec 5047) → board `/postings/{slug}` enumeration (Cheerio) →
  bounded detail fan-out via the shared `parseJobPostingLd` extractor (Spec 5022);
  location, isRemote, compensation, employmentType/jobType, company name; safe
  empty-response behaviour.
- [x] T5 — Unit tests (`gusto-hosted.service.spec.ts`, protected-seam stubs, no
  browser): full mapping, slug consumption, empty/malformed board, detail
  failure, de-dupe, `/applicants/new` stripping, resultsWanted, remote-from-title,
  company precedence, no-slug, companyUrl resolution, description formatting
  (13 tests).
- [x] T6 — Update `docs/index.md`, `docs/log.md`, `docs/ATS_INTEGRATIONS.md`,
  `docs/questions.md`.
- [ ] T7 — Live-capture validation: from an allowed (non-datacenter) browser,
  capture a real board + posting HTML and confirm the `/postings/{slug}` link
  shape and posting JSON-LD before promoting beyond best-effort. Blocked by the
  Cloudflare challenge on the Devin VM (Q in `docs/questions.md`).
