# Plan: 5027 — Greenhouse `isRemote` reads `offices[]` + "Work Location" metadata

| Field | Value |
| --- | --- |
| Spec ID | 5027 |
| Status | implemented |
| Created | 2026-06-28 |

## Phases

1. **Helpers** — add to `greenhouse.service.ts`:
   - `officeLabels(offices)` — remote-evidence labels from each office `name` and
     `location`, accepting both the board (`location: string`) and Harvest
     (`location: { name }`) office shapes.
   - `workLocationLabels(metadata)` — values of the case-insensitive "Work
     Location" metadata entry (string or multi-select array).
   - `mergeWorkFromHomeType(a, b)` — same merge used by the other ATS plugins.
2. **Fix** — in `processJob` and `processHarvestJob`, build a `structuredRemote`
   parse from those labels and set `isRemote = location.remoteMentioned ||
   structuredRemote.remoteMentioned`, `workFromHomeType = merge(location, structured)`.
   `processJob` uses offices + metadata; `processHarvestJob` uses offices only.
3. **Test** — add board-path tests (office-Remote, metadata Work Location Remote /
   Hybrid, non-remote no-false-positive).
4. **Verify** — run the greenhouse suites; typecheck the package + API build.

## Packages touched

- `packages/plugins/source-ats-greenhouse` (src + `__tests__`).

## Risks

- An office or "Work Location" value containing the word "remote" in a
  non-remote sense ("not remote") could in principle flip detection; in practice
  these fields are short structured enums ("Remote" / "Hybrid" / "On-site"), and
  detection only ever *adds* evidence to the existing OR, never removes it — so a
  posting can never become *less* remote than today.
