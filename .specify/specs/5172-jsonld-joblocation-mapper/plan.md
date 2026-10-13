# Plan: 5172 — jsonld-joblocation-mapper

| Field | Value |
| --- | --- |
| Spec ID | 5172 |
| Slug | jsonld-joblocation-mapper |
| Status | draft |
| Owner | agent |
| Created | 2026-10-09 |

## Phases

1. **Spec artifacts** — this spec + tasks; docs index/log rows.
2. **Per-plugin adoption** (one commit-safe pass over 31 plugins):
   - Import `toLocationDtos` (or `toLocationDto`) from `@ever-jobs/common`.
   - At the point the plugin reads `jobLocation.address.*`, replace with
     `toLocationDtos(jobLocation)`; `location` = `dtos[0] ?? null`.
   - Plugins already emitting `locations[]` (bizneo, exacthire, hreasily,
     inrecruiting, pcrecruiter, prescreen): `locations = dtos`.
   - Plugins emitting `locations: [location]` (cezanne, expr3ss, taleez,
     isolved, peoplestrong): keep single-element form from `dtos[0]`.
   - Preserve every `??`/`if (!address)` fallback chain byte-for-byte in
     behavior — mapper-empty triggers the same fallback path as
     no-address today.
   - Remove now-dead helpers (`firstAddress`, `countryName`) only when fully
     unused; keep them when remote detection or fallbacks still call them.
3. **Verify** — per-plugin jest (no test edits), `npx tsc -b`, `lint:docs`.
4. **PR** — branch off develop, conventional commit, PR to develop.

## Packages touched

`packages/plugins/source-{ats-,company-,}?<plugin>/src/*.service.ts` for the 31
plugins; `.specify/specs/5172-*`; `docs/index.md`; `docs/log.md`.
No changes to `@ever-jobs/common` or `@ever-jobs/models`.

## Risks

- **Fallback regresion**: a plugin whose fallback triggers on *empty address
  fields* (not missing object) — e.g. `{address: {}}` — may behave differently
  since the mapper yields `[]` only when nothing usable exists. Mitigate by
  matching the existing guard semantics per plugin.
- **`country` object form**: `{addressCountry: {name: 'X'}}` — mapper's object
  leaves cover `.name`; confirms `countryName()` helpers are redundant.
- **`jobLocation` as string** (peoplestrong `item.jobLocation` text,
  stepstone string form): mapper's string input → `parseLocationList`; verify
  the plugin's own type before choosing object vs string call site.
- ** dedupKey drift**: guarded by the `locations[]`-only-where-already-set rule.

## Per-plugin notes

| Plugin | Input form | locations[] today | Fallback to preserve |
| --- | --- | --- | --- |
| akkencloud/arcoro | Place\|Place[] | none | label/text fallback |
| bizneo | Place\|Place[] | per-site | — |
| brassring | Place\|Place[] | none | `?? job.city` |
| careerplug | Place\|Place[] | none | `applicationLocationRequirement.name` → country |
| cezanne/expr3ss/taleez/isolved/peoplestrong | Place\|Place[] | `[location]` | various text fallbacks |
| concludis/hron/jobtrain/otys/rexx/vivahr/workforce/pageup/hireful/keka/mindscope/namely/paychex/scouttalent/snaphunt | Place\|Place[] | none | label/og:/requirement chains |
| exacthire/hreasily/inrecruiting/pcrecruiter/prescreen | Place\|Place[] | per-site | various |
| stepstone | Place (string fields) | from parseLocationList | label parse |
