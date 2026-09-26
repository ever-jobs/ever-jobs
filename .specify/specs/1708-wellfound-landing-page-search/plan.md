# Plan: 1708 — Wellfound search reads the server-rendered landing pages

| Field        | Value      |
| ------------ | ---------- |
| Spec         | spec.md    |
| Spec ID      | 1708       |
| Status       | done       |
| Created      | 2026-09-25 |
| Last updated | 2026-09-25 |

## 1. Approach

Rewrite the fetch and parse path of `source-wellfound`; registration is unchanged (the site enum,
the plugin barrel, `tsconfig.base.json` and `jest.config.js` already point at the package).

1. **Pure parser (`wellfound.parser.ts`, new).** Payload extraction (`extractNextData`,
   `getApolloData`), cache navigation (`resolveRef` on own keys only, `findSearchConnection` with
   parsed field arguments, `collectListings` in site order), mapping (`mapListing`,
   `parseWellfoundCompensation`, `sizeToEmployees`, `experienceRange`, the Markdown stripper and
   escape-first HTML renderer), routing (`roleSlug`, `locationSlug`, `planRoutes`) and local
   filters (`matchesAllTerms`, `matchesPlace`, `listingPostedMs`). No I/O, no module state.
2. **Constants (`wellfound.constants.ts`, rewritten).** Origin, route builders taking a page
   number, caps, the honest user agent, the payload regex, role aliases, and the four operator
   options with a shared parser.
3. **Types (`wellfound.types.ts`, rewritten).** The verified shapes, plus the pre-Spec-1708
   fields as an explicit legacy interface so the mapper can keep reading them.
4. **Service (`wellfound.service.ts`, rewritten; UTF-8 BOM kept).** Options read per scrape; a
   per-run state object (HTTP client, optional browser page) that never touches `this`; the route
   chain; page classification (payload first); sequential pagination with `randomSleep`;
   diagnostics per spec §7.3; `onModuleDestroy` still closes the browser pool.
5. **Barrel (`index.ts`).** Also exports constants, parser and types for tests and a later shared
   helper with the company-board plugin.

## 2. Phases

### Phase 1 — Parser and types

- Goal: turn a landing page into ordered `JobPostDto`s without any network.
- Deliverables: `wellfound.parser.ts`, `wellfound.types.ts`, `wellfound.constants.ts`,
  synthetic fixtures, `wellfound.parser.spec.ts`.
- Exit criteria: the zero-listings regression and every mapping row covered.

### Phase 2 — Service

- Goal: routes, pagination, diagnostics, options.
- Deliverables: `wellfound.service.ts`, `wellfound.service.spec.ts`.
- Exit criteria: happy path in one GET without a browser; every diagnostic row reachable.

### Phase 3 — Live check and docs

- Goal: prove it against the real site once; write this spec.
- Deliverables: `wellfound.e2e-spec.ts` (gated), spec/plan/tasks.
- Exit criteria: live run returns jobs over HTTP (2 requests), full type-check clean.

## 3. Packages Touched

| Package | Change |
| ------- | ------ |
| `packages/plugins/source-wellfound` | rewritten `src/` (+ new `wellfound.parser.ts`), new `__tests__/` with fixtures |
| `packages/models` | (no change; the shared `looksLikeChallenge` fix is a follow-up) |
| `packages/common` | (no change; uses the Spec 1696 posted-time helpers) |

## 4. Dependencies

None new.

## 5. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
| ---- | ---------- | ------ | ---------- |
| Blocking from datacenter IPs | M | M | Reported as `blocked`; `WELLFOUND_FETCH_MODE=browser` remains for operators |
| Payload shape drift | M | M | `unknown` diagnostic with a drift detail instead of a silent zero |
| Unknown role slug | M | L | Role confirmation plus local-filter fallback to `/jobs` |
| Beacon read as a challenge | H (without the fix) | H | Payload checked first; beacon path removed before the shared detector |

## 6. Rollback Plan

Every changed behaviour has a switch: `WELLFOUND_FETCH_MODE=browser`, `WELLFOUND_ROUTE_MODE=feed`,
`WELLFOUND_DESCRIPTION_SOURCE=html`, `WELLFOUND_JOB_URL_STYLE=slug`, and
`EVER_JOBS_POSTED_TIME_DETAIL=false` for the posted-time detail keys. A full revert is the plugin
directory only; no data or schema is involved.
