# Plan: 1724 — Dedup merge gate: keep one posting per office and per program

| Field        | Value      |
| ------------ | ---------- |
| Spec ID      | 1724       |
| Status       | done       |
| Last updated | 2026-09-25 |

## Approach

1. `merge-gate.ts` (dedup-hybrid): site descriptors, employment classes, the pairwise rule, and
   `MergeGate` — one group of distinct member profiles per Union-Find root, built lazily.
2. `DedupHybridService` pass 2: instead of unioning every member of a proposed cluster with its
   head, place each member with `MergeGate.place` (first compatible sub-group, else a new one),
   yielding on the pass budget. Pass 3: `assignClusterIds` gives colliding clusters discriminated
   ids.
3. `JobsAggregator`: `finalizeRepresentatives` keys the representatives once, gives colliding ones
   their cluster id, and copies merged ones with the `locations[]` union; `stampDedupKeys` skips
   the jobs it already keyed.
4. Regression fixture from the captured crawl, descriptions encoded token-for-token.

## Files

| File | Change |
| ---- | ------ |
| `packages/plugins/dedup-hybrid/src/merge-gate.ts` | new |
| `packages/plugins/dedup-hybrid/src/dedup-hybrid.service.ts` | gated union, unique cluster ids |
| `packages/plugins/dedup-hybrid/__tests__/dedup-merge-gate.spec.ts` | new |
| `packages/plugins/dedup-hybrid/__tests__/fixtures/janestreet-list-mode.fixture.ts` | new |
| `apps/api/src/jobs/jobs.aggregator.ts` | union of locations, distinct keys |
| `apps/api/src/jobs/__tests__/jobs.aggregator.merge-gate.spec.ts` | new |

## Risks

- **Fewer cross-source merges** where a board and the ATS disagree on the place (e.g. a country
  name `canonicalCountryName` does not know). Conservative by design: the cost is a duplicate,
  not a lost posting.
- **Stored ids change** for clusters the gate now splits or that get a discriminated id — once,
  like any key change (Spec 1689's precedent).

## Verification

`dedup-hybrid` suites (incl. perf and event loop), aggregator suites, the mutation checks listed
in the spec's test plan, `tsc`.
