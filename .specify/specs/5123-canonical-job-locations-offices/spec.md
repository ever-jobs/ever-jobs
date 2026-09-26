# Spec 5123 — `CanonicalJob` carries `locations[]`/`offices[]`; site-set identity key

| Field | Value |
|---|---|
| Spec | 5123 |
| Slug | `canonical-job-locations-offices` |
| Status | in-progress |
| Owner | devin |
| Created | 2026-09-15 |
| Last updated | 2026-09-15 |
| Related specs | 003 (dedup), 5119–5122 (per-site `locations[]`/`offices[]` on `JobPostDto`) |

## Problem

`CanonicalJob` — the merged record the dedup engine emits — carries only a
flattened `location` string. The per-site arrays added to `JobPostDto` in
Specs 5119–5122 (`locations[]`, `offices[]`) reach the dedup input but are
dropped at pass-3 materialisation, so any consumer of the deduped record
loses site boundaries the plugins now preserve. `CanonicalJob` is emitted
only on the dedup path (`?dedup=true`, the default on `GET /api/jobs/search`
and GraphQL `searchJobs`) — callers passing `dedup=false` receive raw
`JobPostDto`s and are unaffected by anything here.

Two coupled changes:

1. **Carry the fields.** `CanonicalJob` gains `locations?` and `offices?`.
   A singleton cluster straight-copies its observation's arrays. A
   multi-observation cluster takes the **union**: every distinct site any
   source listed, deduped on `city|state|country` (`name|text` for
   geography-less entries) for `locations` and on `id` (else `name|text`)
   for `offices`. Union — rather than head-wins — because stage-2 (MinHash)
   can weld postings whose site lists genuinely differ, e.g. a repost that
   added a site; head-wins would silently drop those sites.
2. **Location component of the identity key.** `canonicalJobId`'s location
   component is derived from the sorted set of normalised `city|state|country`
   triples in `locations[]` — the richest site data available — instead of
   the flattened `location` string. Site order and label punctuation stop
   affecting identity. When `locations[]` is absent or yields no geography,
   the key falls back to `normalizeLocation(location)` exactly as before,
   so rows without per-site data still merge with each other.

## Scope

- `packages/models`: `CanonicalJob.locations?: ReadonlyArray<LocationDto>`,
  `CanonicalJob.offices?: ReadonlyArray<OfficeDto>`;
  `CanonicalJobSchema` mirror.
- `packages/common`: `CanonicalKeyInput.locations`; location component =
  sorted normalised triples, string fallback.
- `dedup-hybrid`: pass-1 passes `raw.locations` into the key input; pass-3
  unions `locations[]`/`offices[]` across the cluster (head-first, first
  occurrence wins, raw fields preserved on survivors).
- `location` stays populated: it is the fallback scalar for empty/absent
  `locations[]`, not the display source of record.

## Non-goals

- Store persistence of the new arrays (`store-sqlite-drizzle`,
  `store-postgres-prisma` serialise per-column; adding `locations`/`offices`
  columns is a separate migration spec).
- Per-site provenance in `fields` (`sources[]` already records contributing
  observations).
- Changes to stage-2 (MinHash) welding semantics.
- Consumer-side changes (GraphQL/REST search responses return representative
  `JobPostDto`s, already carrying `locations[]` since Specs 5119–5122).

## Contracts

- Singleton cluster ⇒ `canonical.locations`/`offices` are the observation's
  arrays unchanged; absent input ⇒ fields absent.
- Hash-merged cluster (identical keys) ⇒ identical site sets by
  construction; `offices[]` unions on `id`.
- MinHash-welded cluster with differing site sets ⇒ `locations` is the
  superset of both lists, deduped on the geo triple.
- `canonicalKey` is order-insensitive across `locations[]`, ignores the
  flat `location` string when triples exist, and falls back to it otherwise.

## Test Plan

- `canonical-key.spec.ts`: triples-derived component (different flat
  strings, same sites → same key); order-insensitivity; differing sets →
  different keys; no-geography fallback.
- `dedup-hybrid.service.spec.ts`: singleton copy; field absence; offices
  union on `id` across a hash merge; locations union across a MinHash weld
  with differing site sets.
- `tsc --noEmit` on models/common/dedup-hybrid; `npm run lint:docs`.
