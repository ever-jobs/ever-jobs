# Plan: 1692 — Source ATS Plugin: InHire (inhire.app, Brazil)

| Field        | Value      |
| ------------ | ---------- |
| Spec ID      | 1692       |
| Status       | done       |
| Created      | 2026-09-25 |
| Last updated | 2026-09-25 |

## 1. Approach

A new, self-contained package `packages/plugins/source-ats-inhire`, laid out like the sibling ATS
adapters (`source-ats-gupy` for tenant-from-sub-domain, `source-ats-manatal` for the mocked-client
test style), with the pure logic split out so it can be table-tested.

- `inhire.constants.ts` — origin, paths, honest headers, caps, budgets, pacing defaults and their
  env var names, the Brazilian state codes, the contract-label map, the `R$` marker, and the
  cast `INHIRE_SITE` until the `Site` member exists.
- `inhire.types.ts` — the wire shapes (every field optional and narrowed at parse time) and the
  internal candidate / stats types.
- `inhire.helpers.ts` — pure functions: tenant parsing, list cleaning, title search, URL pinning,
  https image URLs, entity-safe plain text, the location label builder and matcher, contract-type
  mapping, workplace flags, the freshness instant, the detail budget, env and body helpers.
- `inhire.state.ts` — the process-wide pacer (synchronous slot reservation for the one API host)
  and a replaceable clock/sleep so tests drive time.
- `inhire.service.ts` — `scrape()`: resolve the tenant (or `bad_input` with no request), build a
  plan from the input and env, read the lean list once, clean and title-filter it, then either emit
  board-mode jobs or walk the candidates in list order with a bounded worker pool (1 by default),
  each request paced, until enough roles match or the budget is spent; map, filter, slice, and
  attach the first failure as the diagnostic.

The shared helpers do the heavy lifting: `createHttpClient` (retries, `Retry-After`, redirect
pinning), `pinUrlToHosts`, `parseLocationList`, `markdownConverter`, `htmlToPlainText`,
`postedFromTimestamp` / `postedTimeFields`, `resolveCompensation`, `getJobTypeFromString`,
`classifyScrapeError`.

## 2. Phases

### Phase 1 — Package and pure logic

- Deliverables: `package.json`, `tsconfig.json`, constants, types, helpers, state; helpers spec.
- Exit: `inhire.helpers.spec.ts` green.

### Phase 2 — Service

- Deliverables: service, module, barrel; synthetic fixtures; service spec.
- Exit: `inhire.service.spec.ts` green; hand mutation checks turn it red.

### Phase 3 — Verification and docs

- Deliverables: opt-in network E2E (run once), spec / plan / tasks, registration values for the
  integrator.
- Exit: E2E 4/4 live; full `tsc --project tsconfig.typecheck.json` clean.

## 3. Packages Touched

| Package | Change |
| ------- | ------ |
| `packages/plugins/source-ats-inhire` | new package |
| `packages/models` | none in this lane; the integrator appends `Site.INHIRE` |
| `packages/plugins/index.ts`, `tsconfig.base.json`, `jest.config.js` | none in this lane; the integrator registers the module and alias |
| `packages/common` | none (uses the shared helpers as they are) |

## 4. Dependencies

| Library | Version | Rationale |
| ------- | ------- | --------- |
| `cheerio` | already a root dependency | decodes named HTML entities before plain-text conversion without touching markup escapes |

No new dependency.

## 5. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
| ---- | ---------- | ------ | ---------- |
| The API changes shape | M | M | every field optional and narrowed; non-array list → `fetch_error`; detail shape errors → diagnostic, never a throw |
| Load on the tenant's API | L | M | honest UA, one origin, 500 ms process-wide gap, sequential details, budgets and a 500-row cap |
| A caller aims the pod elsewhere | L | H | caller URLs are parsed for the tenant only, never fetched; the tenant is a validated DNS label; redirects pinned to the API host |
| Header injection through the tenant | L | H | whitespace / control characters refused before the regex; the header value is the validated label |
| Brazilian state codes read as countries | H | M | trailing UF code always completed with `, Brazil` |
| `R$` read as USD by the shared salary parser | M | M | no salary parsing when the description quotes `R$` / `BRL` |
| Unknown tenant looks like an empty board | H | L | it is one upstream (`200 []`); nothing else to report |

## 6. Rollback Plan

Drop the registration lines (`Site.INHIRE`, the module import and array entry, the path alias and
the jest mapper). The package is self-contained; nothing else depends on it.

## 7. Migration Plan

None: a new source. Existing sources and outputs are unchanged.

## 8. Open Questions for Plan

None blocking. Follow-ups are listed in spec §9.
