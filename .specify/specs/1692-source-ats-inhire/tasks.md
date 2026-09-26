# Tasks: 1692 — Source ATS Plugin: InHire (inhire.app, Brazil)

> Status legend: `[ ]` pending • `[~]` in-progress • `[x]` done • `[-]` dropped

## Phase 1 — Package and pure logic

- [x] T01 — Package scaffold.
  - **Files:** `packages/plugins/source-ats-inhire/{package.json,tsconfig.json,src/index.ts,src/inhire.module.ts}`
  - **Acceptance:** `@ever-jobs/source-ats-inhire`, private, `main`/`types` = `src/index.ts`, peers `@ever-jobs/common` + `@ever-jobs/models`; tsconfig extends `../../../tsconfig.base.json` with `outDir` `dist/packages/source-ats-inhire`; barrel exports `InhireModule` and `InhireService`.
- [x] T02 — Constants and types.
  - **Files:** `src/inhire.constants.ts`, `src/inhire.types.ts`
  - **Acceptance:** fixed origin and path prefix; honest UA; caps (500 rows, 200 details), budgets (50 / 25 / 200), pacing defaults (1 in flight, 500 ms) and env names `INHIRE_DETAIL_CONCURRENCY` / `INHIRE_MIN_INTERVAL_MS`; 27 Brazilian state codes; contract map; `INHIRE_SITE` cast until registration; robots note (API host has no robots file) in the header comment.
- [x] T03 — Pure helpers.
  - **Files:** `src/inhire.helpers.ts`
  - **Acceptance:** `parseInhireTenant` refuses CR/LF, `a..b`, `api`/`files`/`www`, foreign hosts, credentials, ports; `buildLocationLabel` keeps `PR`/`RS`/`SC`/`ES` as states with `, Brazil`; `normaliseHtmlEntities` decodes `&atilde;` and keeps `&amp;`/`&lt;`; `mapContractTypes` never throws on junk.
- [x] T04 — Process-wide pacer.
  - **Files:** `src/inhire.state.ts`
  - **Acceptance:** synchronous slot reservation; replaceable clock and sleep; reset for tests.
- [x] T05 — Helpers spec.
  - **Files:** `__tests__/inhire.helpers.spec.ts`
  - **Acceptance:** 109/109.

## Phase 2 — Service

- [x] T06 — `InhireService.scrape()`.
  - **Files:** `src/inhire.service.ts`
  - **Acceptance:** `bad_input` with no request for missing/invalid tenants; one list call; clean + title pre-filter; board mode; in-order detail walk with a bounded pool, paced, stopping at `offset + resultsWanted` matches or the budget; post-detail filters; mapping per spec §7.1; diagnostics per §7.2; summary log line; never throws; no `console.*`.
- [x] T07 — Synthetic fixtures.
  - **Files:** `__tests__/fixtures/{list-acme,detail-1,detail-2,detail-3,detail-4,detail-5}.json`
  - **Acceptance:** fictitious tenant `acme-br`, fake UUIDs, each file < 3 KB; role 4 closed, role 5 with a foreign link, a non-UUID row, a duplicate row, role 6 without a detail.
- [x] T08 — Service spec.
  - **Files:** `__tests__/inhire.service.spec.ts`
  - **Acceptance:** 68/68 with a mocked client and a virtual clock; asserts the `X-Tenant` header, the honest client options, max in-flight (1 default, 2 with the env, clamped), ≥ 500 ms gaps including across two concurrent scrapes, and the `R$` guard against an input the shared parser alone reads as USD.
- [x] T09 — Mutation check by hand.
  - **Acceptance:** disabling the salary guard (1 red), the pacer (4), the sequential default (4), the `isRemote === true` rule (16) or the link pin (2) turns the suite red; restored afterwards.

## Phase 3 — Verification and docs

- [x] T10 — Opt-in network E2E.
  - **Files:** `__tests__/inhire.e2e-spec.ts`
  - **Acceptance:** skipped unless `RUN_NETWORK_E2E=1`; ≤ 1 list + 3 detail calls per case; run once live 2026-09-25: 4/4.
- [x] T11 — Live answers to the design's open questions (Q1 heavier list, Q4 unknown tenant), one request each, recorded in spec §10.
- [x] T12 — Spec, plan, tasks.
  - **Files:** `.specify/specs/1692-source-ats-inhire/{spec,plan,tasks}.md`
- [x] T13 — Type-check.
  - **Acceptance:** `npx tsc --project tsconfig.typecheck.json --noEmit` exits 0.
- [x] T14 — Registration (integrator): `Site.INHIRE = 'inhire'`, `InhireModule` in `packages/plugins/index.ts`, the `tsconfig.base.json` path and the `jest.config.js` mapper (values in spec §7.4); then switch `INHIRE_SITE` and the specs' `SITE` to `Site.INHIRE`.
- [x] T15 — `docs/index.md` row and `docs/log.md` entry (integrator).

## Notes

- Tests import the service by relative path until the path alias is registered.
- Follow-ups (not in this spec): BRL in the shared salary parser, a `Brasil` alias in the location
  parser, crawl limits on `@SourcePlugin` once the metadata supports them (done at the Spec 1690 merge, 2026-09-26: `INHIRE_CRAWL_POLICY` = at most 2 in flight, 500 ms apart), multi-career-page
  tenants (Q2).

Integration 2026-09-25: registered as `Site.INHIRE` / `InhireModule` (site enum, plugin index, `tsconfig.base.json`, `jest.config.js`, `tool_manifest.json`, README); the specs use `Site.INHIRE` and the package alias; `docs/index.md` / `docs/log.md` rows added.
