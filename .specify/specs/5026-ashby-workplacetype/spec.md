# Spec: 5026 — Ashby `isRemote` reads structured `workplaceType`

| Field | Value |
| --- | --- |
| Spec ID | 5026 |
| Slug | ashby-workplacetype |
| Status | implemented |
| Owner | agent |
| Created | 2026-06-28 |
| Last updated | 2026-06-28 |
| Related specs | 5008, 5025 |

## Problem

Ashby exposes two remote signals per posting: a coarse boolean `isRemote` and a
structured `workplaceType` (`OnSite` / `Hybrid` / `Remote`). The plugin reads
only the boolean —

```ts
isRemote: Boolean(job.isRemote) || parsedLocations.remoteMentioned,
workFromHomeType: parsedLocations.workFromHomeType,
```

— and Ashby sets `isRemote=true` for **Hybrid** roles as well as Remote ones.
So Hybrid postings (`isRemote=true`, `workplaceType='Hybrid'`) are mislabelled
`isRemote: true`, and `workFromHomeType` is sourced only from location *text*,
so a Hybrid role located "Austin, TX" emits `isRemote: true` with **no**
`workFromHomeType` — the one field that says "Hybrid" is discarded. Hybrid
postings are therefore mislabelled remote across the harvested Ashby corpus. The
plugin's types also never modelled `workplaceType`, so it was blind to the field.

## Scope

- Add `workplaceType?: string | null` to `AshbyJob` (the public board API and the
  authenticated Posting API both return it).
- Derive `isRemote` from `workplaceType` (true only when `Remote`), falling back
  to the boolean `isRemote` when `workplaceType` is absent, OR'd with the
  location-text `remoteMentioned` (unchanged behaviour for text-only remote).
- Map `workplaceType` to `workFromHomeType` (`Remote`→`Remote`, `Hybrid`→`Hybrid`,
  `OnSite`/absent→none), merged with the location-text value, mirroring the
  existing lever plugin.

## Non-goals

- No change to the shared `parseLocationList` or its regexes.
- No new `workFromHomeType` vocabulary (e.g. an explicit `On-site`/`Unknown`
  state) — `OnSite` continues to resolve to none, consistent with lever/workday/
  workable.
- No plugin imports another plugin.

## Contracts

- `JobPostDto.isRemote` / `JobPostDto.workFromHomeType` shapes unchanged.
- A Hybrid posting (`isRemote=true`, `workplaceType='Hybrid'`) now yields
  `isRemote: false`, `workFromHomeType: 'Hybrid'`.
- A Remote posting (`workplaceType='Remote'`) yields `isRemote: true`,
  `workFromHomeType: 'Remote'`.
- A posting with no `workplaceType` falls back to the boolean `isRemote` (and the
  location text), so payloads that omit the field are behaviour-preserving.

## Test plan

- **Ashby service** — three cases:
    - `workplaceType: 'Hybrid'` + `isRemote: true` → `isRemote: false`,
      `workFromHomeType: 'Hybrid'` (the regression).
    - `workplaceType: 'Remote'` → `isRemote: true`, `workFromHomeType: 'Remote'`.
    - no `workplaceType`, `isRemote: true` → `isRemote: true` (boolean fallback).
- Existing Ashby suites stay green (the text-only `Remote` location case still
  resolves to `isRemote: true` / `workFromHomeType: 'Remote'`).
