# Plan: 1701 — LinkedIn guest board: pagination, stable ids, pay, detail fields and company enrichment

| Field        | Value       |
| ------------ | ----------- |
| Spec ID      | 1701        |
| Status       | in-progress |
| Last updated | 2026-09-25  |

## 1. Approach

Split the plugin into I/O and parsing. `linkedin.parser.ts` holds pure functions over HTML
(`parseSearchCards`, `cardToJobPost`, `cardPostedTime`, `parseJobDetail`, `parseCompanyPage`) so each
rule is tested against fixtures without a network. `linkedin.service.ts` keeps only requests,
pacing, merging and diagnostics. `linkedin.utils.ts` keeps every existing export (fixing
`parseJobType` and `isJobRemote`, with the old behaviour behind an option) and adds the small
helpers: ids, company URLs, pay, applicants, criteria, the remote detector, URL guards, block
detection and the two switches. `linkedin.types.ts` names the parser results and the three extra
job fields; `linkedin.constants.ts` gains the caps, codes and the currency table.

Pagination advances by the cards on the page and stops on an empty page, at `start` 1000, after two
pages with no new id, at `resultsWanted` or on an error. One pacer shared by search, detail and
company requests keeps everything sequential with 3–7 s between requests.

Detail parsing removes the "similar jobs" cards first, then scopes every query to the top card and
the posting details. Criteria are read by label. The detail merge overrides the card for pay, job
type, level, function and industry and fills gaps for the rest.

Blocks are recognised by HTTP 999 or a sign-in-wall final URL, on both errors and 200 responses,
and reported as `blocked`; any other failure goes through `classifyScrapeError`. Search failures
keep the partial list; detail failures keep the card-only job; company failures never report.

Company enrichment is opt-in: one GET per unique slug, 25 at most, cached per call, stopped by a
block. It fills only empty fields and prefers the size band over the JSON-LD member count.

Posted time follows Spec 1696: `postedFromRelativeLabel` on the card (the attribute stays the
`datePosted`), and a JSON-LD instant from the detail page upgrades to `exact` when it agrees.

Every changed behaviour stays reachable through `EVER_JOBS_LINKEDIN_LEGACY`, read on each call.

## 2. Phases

### Phase 1 — Parsing and helpers

- Deliverables: `linkedin.types.ts`, `linkedin.parser.ts`, new helpers in `linkedin.utils.ts`,
  constants.
- Exit criteria: utils and parser suites green against synthetic fixtures; the three probe samples
  parse as expected in a local check (not committed).

### Phase 2 — Service

- Deliverables: pagination, pacer, diagnostics, detail merge, company enrichment, posted-time
  counters, legacy switches.
- Exit criteria: the service suite green with the client and sleeps mocked.

### Phase 3 — Live and docs

- Deliverables: gated live cases in `linkedin.e2e-spec.ts`; this spec folder.
- Exit criteria: full type-check has no errors in the plugin.

## 3. Packages Touched

| Package | Change |
| ------- | ------ |
| `packages/plugins/source-linkedin` | service rewrite around a pure parser; utils fixes and helpers; types; constants; three new unit suites, seven fixtures, gated live cases |
| `packages/models` | (no change here — `JobPostDto` / `ScraperInputDto` declarations are Q1) |
| `packages/common` | (no change — uses Spec 1695 and 1696 helpers as landed) |
| `apps/cli` | (no change here — flag is Q2) |

## 4. Dependencies

| Library | Version | Rationale |
| ------- | ------- | --------- |
| `cheerio` | existing | already the plugin's HTML parser |

## 5. Verification

- `npx jest --testPathPatterns "source-linkedin/__tests__/linkedin\.(utils|parser|service)" --maxWorkers=4`
- `npx tsc --project tsconfig.typecheck.json --noEmit`
- Live (opt-in): `RUN_NETWORK_E2E=1 npx jest --testPathPatterns "source-linkedin/__tests__/linkedin\.e2e"`
