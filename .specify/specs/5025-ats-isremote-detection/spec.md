# Spec: 5025 — Workday `isRemote` detects `Remote_*` locations

| Field | Value |
| --- | --- |
| Spec ID | 5025 |
| Slug | ats-isremote-detection |
| Status | implemented |
| Owner | agent |
| Created | 2026-06-28 |
| Last updated | 2026-06-28 |
| Related specs | 5013 |

## Problem

Workday postings whose location is a slug like `Remote_USA` are not flagged as
remote. The service matches location labels with `parseLocationList`, whose
remote check is `/\bremote\b/i`. The underscore in `Remote_USA` is a word
character, so the `\b` boundary after `Remote` never matches and `isRemote`
stays `false`.

## Scope

Normalize underscores to spaces (and collapse whitespace) on workday location
labels before `parseLocationList`, so `Remote_USA` → `Remote USA`.

## Non-goals

- No change to the shared `parseLocationList` regexes.
- No new dependency; no plugin imports another plugin.

## Contracts

- `JobPostDto.isRemote` / `JobPostDto.location` shape unchanged; only detection
  for underscore-slugged remote labels is corrected.

## Test plan

- **Workday service** — a posting with `locationsText: "Remote_USA"` yields
  `isRemote: true` and a location free of underscores. Existing suites stay
  green (behaviour-preserving for labels without underscores).
