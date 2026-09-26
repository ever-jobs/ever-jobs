# Tasks: 1711 — BDJobs on the public JSON search and details API

> Status legend: `[ ]` pending • `[~]` in-progress • `[x]` done • `[-]` dropped

## Phase 1 — API path

- [x] T01 — Wire types for the search and details responses.
  - **Files:** `packages/plugins/source-bdjobs/src/bdjobs.types.ts`
  - **Acceptance:** every field optional/nullable; the IP echo and other ignored fields are not modelled.
- [x] T02 — Constants: API URLs, page size 30, `BDJOBS_MAX_PAGES` 20, headroom 2, details budgets, 45 s time budget, 3-failure stop, delays, honest headers, `BDJOBS_MODE` / `BDJOBS_STRATEGY` names; legacy constants kept and marked `@deprecated`.
  - **Files:** `src/bdjobs.constants.ts`
  - **Acceptance:** no constant deleted; no path sends a browser User-Agent.
- [x] T03 — Pure helpers: `parseBdjobsSalary`, `detailSalary`, `parseMonthDayYear`, `parseBdjobsCalendarDate`, `isoDateOnly`, `publishInstantMs`, `mapJobType`, `mapWorkplace`, `isHomeWorkplace`, `bdjobsLocationLabel`, `buildLocation`, `splitSkills`, `mergeEmails`, `sectionHtml`, `buildDescriptionHtml`, `formatDescription`, `mapListItem`, `applyDetails`, `interpretSearchBody`, `interpretDetailBody`, `resolveBdjobsMode`.
  - **Files:** `src/bdjobs.parse.ts`
  - **Acceptance:** no `new Date(freeText)`; linear regexes; `bdjobs.parse.spec.ts` 88/88.
- [x] T04 — Service rewrite: client with both timeout keys, retries/rate delays, pinned redirects and honest headers; sequential capped pagination with premium-first union, one `seenIds`, offset skip, filters and the no-new-ids stop; budgeted sequential details pass; diagnostics per spec §7.2; `description` on the decorator.
  - **Files:** `src/bdjobs.service.ts` (BOM and LF kept)
  - **Acceptance:** `bdjobs.service.spec.ts` 45/45.
- [x] T05 — Fixtures trimmed from the probe samples: two search pages, empty search, details (IP set to `0.0.0.0`), details not found, 297-byte site shell.
  - **Files:** `__tests__/fixtures/bdjobs-*.json`, `bdjobs-spa-shell.html`
  - **Acceptance:** no sign-in token, phone number or real IP in any fixture.
- [x] T06 — Live verification: one run of the tightened e2e (1 search + 2 details) and one inspected run. Found `CompanyBusiness` sometimes holding a company profile; split into `companyIndustry` / `companyDescription` (spec D-09) with a test.
  - **Files:** `__tests__/bdjobs.e2e-spec.ts`, `src/bdjobs.parse.ts`
  - **Acceptance:** e2e green with unconditional assertions.
- [x] T07 — Mutation controls: the seen-id check, the deadline, the no-new-ids stop, the time budget and non-JSON handling each turn the service suite red when broken.
  - **Acceptance:** 7 / 3 / 1 / 1 / 3 failures respectively; files restored byte-for-byte.

## Phase 2 — Legacy path reachable

- [x] T08 — Move the cheerio scraper into `BdjobsLegacyHtmlScraper`; patch the deadline, `.first()`, seen-id-before-details, page cap, no-new-ids stop, shell/challenge diagnostic, honest User-Agent, time-zone-safe card dates.
  - **Files:** `src/bdjobs.legacy-html.ts`, `__tests__/fixtures/bdjobs-legacy-*.html`, `__tests__/bdjobs.legacy-html.spec.ts`
  - **Acceptance:** `bdjobs.legacy-html.spec.ts` 12/12.
- [x] T09 — `BDJOBS_MODE=api|html` (default `api`), `BDJOBS_STRATEGY=legacy-html` alias, warning on an unrecognised value.
  - **Acceptance:** covered in the parse and service suites.

## Phase 3 — Close-out

- [x] T10 — Type-check: scoped to the plugin, clean; full tree, no error in this plugin.
- [x] T11 — Integrator: `README.md` BDJobs row ("REST API (public JSON)") and usage line; `docs/index.md` / `docs/log.md` rows.
- [ ] T12 — Follow-ups F1–F5 (crawl manifest, `postedWithin`, location ids, `rpp`, `jobNature` / `jobLevel`).

## Notes

- 145 unit tests across the three suites (88 + 45 + 12).
- No registration changes: `packages/plugins/index.ts`, `tsconfig.base.json`, `jest.config.js`, the CLI and MCP already know `bdjobs`.

Integration 2026-09-25: README BDJobs row ("REST API (public JSON)") and section, `docs/index.md` / `docs/log.md` rows.
