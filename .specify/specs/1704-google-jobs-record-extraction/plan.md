# Plan: 1704 — Google Jobs rows come from one record each, or not at all

| Field        | Value      |
| ------------ | ---------- |
| Spec ID      | 1704       |
| Status       | done       |
| Created      | 2026-09-25 |
| Last updated | 2026-09-25 |

## 1. Approach

A data-honesty patch, not a rewrite. The request, headers and loop stay what they were; what changes is
how the page is read and what a zero-row answer says.

1. **`google.parser.ts` (new, pure).** `findArrayEnd` walks from a `[` to its matching `]`, tracking
   JSON string and escape state, under a per-record limit. `findJobRecords` finds `"<key>":[`
   occurrences for the known keys, parses each balanced slice and keeps values that pass
   `isJobRecord`; when the known keys yield nothing it repeats with any 9-digit key and reports that
   it did. Keys inside an accepted record are skipped, and the whole page shares a scan budget and a
   candidate cap. `googleRecordToJobPost` maps one record to one row; `parseGoogleJobRecords` dedupes a
   page by id. `extractGoogleCursor` reads `data-async-fc` from the `Yust4d` element with cheerio.
   `looksLikeGoogleInterstitial` recognises Google's own walls with plain substring checks and a
   bounded per-tag look at `<meta>` refreshes.
2. **`google.constants.ts` (new).** Endpoint, known keys, scan bounds, page cap, diagnostic details and
   the two env switches with their readers.
3. **`google.service.ts`.** `scrape` builds the query as before and picks a path.
   `scrapeRecords` makes the same first request, collects rows through the parser, reads the cursor,
   and only then runs `paginateRecords` — the old loop, same request and retry rules, now deduping,
   stopping on a page with no new rows, capped, and returning `partial` or the classified error when it
   gives up. A zero-row result gets `blocked` or `unknown`. A first-page error goes through
   `classifyGoogleError`, which upgrades a Google interstitial response to `blocked`.
   `scrapeLegacy` is the old body, verbatim but for the page cap; `parseGoogleJobs` is untouched and
   `hashCode` delegates to the shared `googleHashCode` (same arithmetic).
4. **`index.ts`** re-exports the parser and constants for the specs.
5. **e2e** gated by `RUN_NETWORK_E2E`, with assertions that would catch a misattributed or synthetic URL.

## 2. Phases

### Phase 1 — parser and constants

- Goal: pure record extraction with bounded work.
- Exit criteria: parser spec green, including the hostile-input bound.

### Phase 2 — service wiring and diagnostics

- Goal: record path by default, legacy path behind the env switch, cursor-gated capped loop.
- Exit criteria: service spec green; the misattribution regression passes on the new path and the same
  page misattributes on the legacy path.

### Phase 3 — e2e gate and docs

- Goal: no live request in CI; this spec folder.

## 3. Packages Touched

| Package | Change |
| ------- | ------ |
| `packages/plugins/source-google/src/google.parser.ts` | new |
| `packages/plugins/source-google/src/google.constants.ts` | new |
| `packages/plugins/source-google/src/google.service.ts` | record path, cursor gate, page cap, diagnostics, legacy path |
| `packages/plugins/source-google/src/index.ts` | re-exports |
| `packages/plugins/source-google/__tests__/google.parser.spec.ts` | new |
| `packages/plugins/source-google/__tests__/google.service.spec.ts` | new |
| `packages/plugins/source-google/__tests__/google.e2e-spec.ts` | gated behind `RUN_NETWORK_E2E` |
| `packages/plugins/source-google/__tests__/fixtures/*` | new, synthetic |
| `packages/models`, `packages/common` | (no change) |

## 4. Dependencies

| Library | Version | Rationale |
| ------- | ------- | --------- |
| `cheerio` | already a dependency | cursor attribute lookup, independent of attribute order and quoting |

## 5. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
| ---- | ---------- | ------ | ---------- |
| The legacy `ibp=htl;jobs` page no longer carries the record payload | H | M | the plugin now answers `unknown` with a detail instead of wrong rows; moving endpoints needs an owner ruling (spec §9) |
| Google rotates the payload key | M | M | shape fallback plus a `warn` naming the new key |
| A large or hostile page makes the scan expensive | L | M | per-record limit, per-page budget, candidate cap; nested keys skipped |
| Someone relies on the old rows | L | L | `EVER_JOBS_GOOGLE_LEGACY_PARSER=true` restores them |

## 6. Rollback Plan

Set `EVER_JOBS_GOOGLE_LEGACY_PARSER=true` (read on every scrape) to return to the old read path; raise
`EVER_JOBS_GOOGLE_MAX_PAGES` to lift the cap.
Reverting the commit removes the new files and restores the old service.

## 7. Migration Plan

None. Output fields are a superset of the old ones; `id` values change from URL hashes to
`go-<record id>`, which is the point (the old ids were unstable).

## 8. Open Questions for Plan

See spec §9 (user-agent policy, first-request vertical, extra fields).
