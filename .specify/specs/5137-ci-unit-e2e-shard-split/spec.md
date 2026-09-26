# Spec: 5137 — Split source-plugin CI into unit (3 shards) + e2e (6 shards)

| Field | Value |
| ----- | ----- |
| Status | Implemented |
| Date | 2026-09-21 |
| Author | Devin |

## Problem

`Test (Source Scrapers N/6)` shards run the full `packages/plugins/source-`
corpus — ~1,600 mocked unit suites and ~250 live `*.e2e-spec.ts` suites
intermixed. Two consequences:

- **Attribution is broken.** Live-network timeouts (e.g. `heyrecruit.e2e-spec`
  30 s timeouts against heyrecruit.de) red a unit shard, masking whether the
  failure is a code regression or a live-site/network issue. ~40% of recent
  develop merges had ≥1 red shard, all masked by `continue-on-error`.
- **Globals tax every suite.** `jest.config.js` sets `maxWorkers: 1` and
  `testTimeout: 120_000` for e2e's benefit — serializing all ~1,600 unit
  suites and giving stuck unit tests 2 minutes.

## Scope

Single file: `.github/workflows/ci.yml`. No change to `jest.config.js`.

## Changes

1. Delete the pre-split 6-shard sizing comment block; keep a 2-line note
   explaining the unit/e2e division.
2. `test-sources` → `Test (Source Scrapers unit N/3)`: adds
   `--testPathIgnorePatterns 'e2e-spec'`, `--maxWorkers=50%`,
   `--workerIdleMemoryLimit=1G`, `--testTimeout=30000`, and
   `--reporters=default --reporters=github-actions` (per-test check
   annotations). Drops `EXA_API_KEY` (only `exa.e2e-spec.ts` needs it).
3. New `test-source-e2e` job → `Test (Source Scrapers e2e N/6)`:
   `--testPathPatterns 'source-.*e2e-spec'`, 6 shards, keeps
   `EXA_API_KEY`, inherits `maxWorkers: 1` + `testTimeout: 120_000` from
   `jest.config.js` unchanged, plus the github-actions reporter.

## Partition (verified via `jest --listTests`)

| Job | Filter | Suites |
| --- | --- | --- |
| `test-sources` | `packages/plugins/source-` minus `e2e-spec` | 1,600 |
| `test-source-e2e` | `source-.*e2e-spec` | 253 |

`apps/*` e2e specs are untouched — they run under the existing `test-e2e`
job with different patterns.

## Non-goals

- No jest.config.js changes (globals stay; e2e needs them, unit overrides via CLI).
- No new e2e coverage for `source-company-*` plugins.
- Shard counts are first guesses to be resized from first-run durations.
