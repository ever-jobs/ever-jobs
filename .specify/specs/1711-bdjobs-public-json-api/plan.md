# Plan: 1711 — BDJobs on the public JSON search and details API

| Field        | Value      |
| ------------ | ---------- |
| Spec ID      | 1711       |
| Status       | done       |
| Created      | 2026-09-25 |
| Last updated | 2026-09-25 |

## 1. Approach

Rebuild `scrape()` on the two public JSON endpoints, keep the old cheerio path behind an env
switch, and move every mapping rule into pure helpers so each one is tested without HTTP.

1. **Types** (`bdjobs.types.ts`): the list row, search response, details payload and details
   response, every field optional or nullable (the API is unversioned).
2. **Pure helpers** (`bdjobs.parse.ts`): salary, calendar dates without `Date`, job type with a
   `JobNature` alias map, workplace, location label, skills, emails, description sections,
   format conversion, `mapListItem`, `applyDetails`, and shape-based interpretation of both
   responses (`interpretSearchBody`, `interpretDetailBody`), plus `resolveBdjobsMode`.
3. **Service** (`bdjobs.service.ts`): resolve the mode; on the API path build honest headers
   and a redirect-pinned client with both timeout keys, walk pages sequentially (premium first,
   one `seenIds`, offset skip, filters, stop rules), then run one budgeted, sequential details
   pass over the kept jobs only. Diagnostics follow the spec's error table.
4. **Legacy path** (`bdjobs.legacy-html.ts`): the old scraper moved into
   `BdjobsLegacyHtmlScraper`, patched (deadline, `.first()`, seen-id before details, page cap,
   no-new-ids stop, shell/challenge diagnostic, honest User-Agent). Reached only through
   `BDJOBS_MODE=html`.
5. **Tests**: parse, service and legacy suites on synthetic fixtures trimmed from the probe
   samples (the caller's IP scrubbed); the live e2e made unconditional.

## 2. Phases

### Phase 1 — API path

- Goal: real jobs from the JSON API with every legacy field still produced.
- Deliverables: types, parse helpers, rewritten service, fixtures, parse + service suites.
- Exit criteria: all design test cases green; mutation controls red.

### Phase 2 — Legacy path reachable

- Goal: no behaviour removed.
- Deliverables: `bdjobs.legacy-html.ts`, `BDJOBS_MODE` switch, legacy suite.
- Exit criteria: `BDJOBS_MODE=html` runs the old scraper with its patches.

### Phase 3 — Verification

- Goal: prove it against the live board once.
- Deliverables: tightened e2e; one live run (1 search + 2 details requests).
- Exit criteria: e2e green; output inspected.

## 3. Packages Touched

| Package | Change |
| ------- | ------ |
| `packages/plugins/source-bdjobs` | rewritten service, new `bdjobs.parse.ts`, `bdjobs.types.ts`, `bdjobs.legacy-html.ts`, reworked constants, `index.ts` exports the helpers and types, new fixtures and three suites, tightened e2e |
| `packages/models`, `packages/common`, `apps/*` | (no change) |

Registration (`packages/plugins/index.ts`, `tsconfig.base.json`, `jest.config.js`, CLI, MCP) is
unchanged. `README.md` (BDJobs row: "REST API (public JSON)" and a one-line usage note) is left
to the integrator.

## 4. Dependencies

| Library | Version | Rationale |
| ------- | ------- | --------- |
| (none new) | — | `cheerio` stays for the legacy path only |

## 5. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
| ---- | ---------- | ------ | ---------- |
| The unversioned API changes shape | M | H | Shape validation turns drift into `unknown` / `fetch_error` instead of a silent zero |
| Details host slow or down | M | M | Sequential, 45 s budget from scrape start, stop after 3 consecutive failures, list-only jobs still returned, all-failed diagnostic |
| A server that ignores `pg` | L | M | Stop on a page with no new ids; 20-request cap |
| Host time zone shifts dates | — | M | No `new Date(freeText)` anywhere; three-`TZ` test |

## 6. Rollback Plan

Set `BDJOBS_MODE=html` to run the pre-1711 scraper (with its fixes) without a deploy of code;
reverting the plugin directory restores the old files exactly. No data or schema is touched.
