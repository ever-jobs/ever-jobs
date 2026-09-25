# Plan: 5123 — `CanonicalJob` `locations[]`/`offices[]`; site-set identity key

| Field | Value |
|---|---|
| Spec | 5123 |
| Slug | `canonical-job-locations-offices` |
| Status | in-progress |
| Owner | devin |
| Created | 2026-09-15 |
| Last updated | 2026-09-15 |
| Related specs | 003, 5119, 5120, 5121, 5122 |

## Phases

1. **Models + schema.** `CanonicalJob.locations`/`offices` (optional,
   readonly); `CanonicalJobSchema` mirrors both arrays.
2. **Key.** `CanonicalKeyInput.locations`; `locationKeyComponent` builds the
   sorted set of `normalizeLocation("city, state, country")` per site,
   `;`-joined; empty set falls back to `normalizeLocation(location)`.
3. **Engine.** Pass-1 key input gains `raw.locations`; pass-3 adds
   `unionLocations` (dedupe `city|state|country`, `name|text` fallback) and
   `unionOffices` (dedupe `id`, else `name|text`), head-first ordering;
   fields emitted only when non-empty.
4. **Tests.** Four key cases + four engine cases per spec contracts.
5. **Docs + PR.** `docs/index.md` row, `docs/log.md` entry,
   `tsc --noEmit`, `lint:docs`, conventional commit, PR to `develop`.

## Risks

- Key change alters `canonicalJobId` values for postings with
  `locations[]` — persisted rows keyed on old ids won't join new ones;
  documented in the spec/log as expected (dedup ids re-derive per pass).
- Union dedupe keys are lowercase-compared; entries differing only in case
  collapse to the first occurrence — acceptable, matches normalisation
  semantics elsewhere.
