# Tasks: 1724 — Dedup merge gate: keep one posting per office and per program

| Field        | Value      |
| ------------ | ---------- |
| Spec ID      | 1724       |
| Status       | done       |
| Last updated | 2026-09-25 |

- [x] T1 — `merge-gate.ts`: sites, employment classes, pairwise rule, `MergeGate`. Acceptance: pure-helper tests.
- [x] T2 — Gated union in `DedupHybridService` pass 2; unique cluster ids in pass 3. Acceptance: the Jane Street fixture stays 30 (its control reproduces 30 → 20); location and employment rule tests; the two New York SOC postings get distinct, deterministic ids; every existing dedup suite passes unchanged.
- [x] T3 — Aggregator: union of locations on the kept job (a copy), distinct `dedupKey`s for postings the engine kept apart. Acceptance: `jobs.aggregator.merge-gate.spec.ts`; the input array is not mutated.
- [x] T4 — Mutation checks (spec §7) and docs: `docs/index.md`, `docs/log.md`, README dedup note.
