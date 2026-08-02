# Spec: 5027 — Greenhouse `isRemote` reads `offices[]` + "Work Location" metadata

| Field | Value |
| --- | --- |
| Spec ID | 5027 |
| Slug | greenhouse-offices-metadata-remote |
| Status | implemented |
| Owner | agent |
| Created | 2026-06-28 |
| Last updated | 2026-06-28 |
| Related specs | 5009, 5025, 5026 |

## Problem

Unlike Ashby (`isRemote` / `workplaceType`) or Workday (`remoteType`), Greenhouse
exposes **no structured remote flag** on a posting. The plugin therefore infers
`isRemote` solely from the role `location` text —

```ts
isRemote: parsedLocations.remoteMentioned,
workFromHomeType: parsedLocations.workFromHomeType,
```

— so a remote posting whose `location.name` is a concrete city (or empty) but
whose remote-ness lives in the company `offices[]` (e.g. an office literally named
"Remote") or in the company-defined `metadata` "Work Location" entry is
mislabelled `isRemote: false`. Those two structured fields are Greenhouse's only
machine-readable remote evidence, and both are currently discarded for remote
detection (`offices[]` is consulted only as a *location-display* fallback;
`metadata` is read only for salary / employment type).

## Scope

- Fold Greenhouse's structured remote evidence into the `isRemote` OR:
    - `offices[]` — every office `name` (and its `location`), parsed through the
      shared location parser.
    - the company-defined `metadata` entry whose `name` is "Work Location"
      (case-insensitive), whose value may be a single string or a multi-select
      array.
- Map a `workFromHomeType` from the same structured evidence and merge it with
  the location-text value (`Remote`→`Remote`, `Hybrid`→`Hybrid`, differing→
  `Hybrid or Remote`), mirroring the ashby/lever plugins.
- Apply to both code paths: the public board `processJob` (offices + metadata)
  and the authenticated Harvest `processHarvestJob` (offices only — the Harvest
  list endpoint carries no company metadata).

## Non-goals

- No change to the shared `parseLocationList` / location regexes.
- No change to how the role `location` is *displayed* — `location.name` (falling
  back to `offices[0].name`) remains the single display source; offices/metadata
  feed only remote detection.
- No new `workFromHomeType` vocabulary; an on-site "Work Location" resolves to
  none, consistent with the other ATS plugins.
- No plugin imports another plugin.

## Contracts

- `JobPostDto.isRemote` / `JobPostDto.workFromHomeType` shapes unchanged.
- A posting with `location.name: 'Austin, TX'` and an office named "Remote" now
  yields `isRemote: true`, `workFromHomeType: 'Remote'`.
- A posting with a "Work Location" metadata value of `Remote` yields
  `isRemote: true`; a value of `Hybrid` yields `isRemote: false`,
  `workFromHomeType: 'Hybrid'`.
- A posting whose offices/metadata carry no remote signal is behaviour-preserving
  (falls back to the location-text result, exactly as today).

## Test plan

- **Greenhouse service** (public board path), new cases:
    - `location.name: 'Austin, TX'` + office `{ name: 'Remote' }` → `isRemote:
      true`, `workFromHomeType: 'Remote'`.
    - `location.name: 'Austin, TX'` + `metadata` `{ name: 'Work Location', value:
      'Remote' }` → `isRemote: true`.
    - `metadata` `{ name: 'Work Location', value: 'Hybrid' }` → `isRemote: false`,
      `workFromHomeType: 'Hybrid'`.
    - concrete office + non-remote location → `isRemote: false` (no false
      positive).
- Existing Greenhouse suites stay green (text-only `Remote` location still
  resolves to `isRemote: true`).
