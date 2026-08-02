# Spec: 5024 — `datePosted` keeps the source local day (repo-wide)

| Field | Value |
| --- | --- |
| Spec ID | 5024 |
| Slug | greenhouse-dateposted-local-day |
| Status | implemented |
| Owner | agent |
| Created | 2026-06-28 |
| Last updated | 2026-06-28 |
| Related specs | 5009 |

## Problem

An ATS audit (alt-path probe vs `source-ats-greenhouse`
plugin, run 2026-06-28 over 135 companies) found a consistent `date_posted`
discrepancy on every Greenhouse posting made in the evening US time: 30/30 such
jobs reported a date **one day later** than the source.

Greenhouse returns `first_published` (public board) / `opened_at` (Harvest) as
an ISO-8601 timestamp **with an explicit offset**, e.g.
`2026-04-20T22:32:33-04:00`. The plugin reduced it to a date with:

```ts
new Date(datePosted).toISOString().split('T')[0]
```

`toISOString()` first shifts the instant to **UTC** (`2026-04-21T02:32:33Z`) and
only then truncates, so the calendar day rolls forward to `2026-04-21`. The
posting's own day (the 20th) is lost for anything published after ~20:00 ET.

This is a long-standing upstream behaviour (introduced 2026-02-08, commit
`b0cd2db4`, "feat: add more sources"), not a fork regression. The same
`new Date(x).toISOString().split('T')[0]` pattern is the **house convention**,
used in ~227 plugin files (both inline at the call site and inside bespoke
per-plugin `parseDate`/`toDateOnly`/`toIsoDate` helpers). Greenhouse is just the
case the regression happened to sample; every offset-bearing source has the same
latent off-by-one. The fix therefore has to be repo-wide, not greenhouse-only.

## Scope

1. **Shared helper** `toDateOnly(value)` in `@ever-jobs/common`
   (`converters/date-converter.ts`): for an ISO-8601 string, preserve the
   leading `YYYY-MM-DD` (the calendar day as written in the timestamp's own
   offset); for non-ISO inputs (epoch number, `Date`, other formats) fall back
   to the historical UTC truncation; `null`/empty/invalid → `null`.
2. **Wire `source-ats-greenhouse`** — both the public-board (`processJob`,
   `first_published`) and Harvest-API (`opened_at`) paths use `toDateOnly`.
3. **Repo-wide adoption** — route **every** date-only normalization through the
   single shared helper so the date math lives in one tested place instead of
   ~227 near-duplicates. Applied with an AST codemod (TS compiler API):
   - **Inline** `new Date(EXPR).toISOString().split('T')[0]` → `toDateOnly(EXPR)`.
   - **Bespoke helpers** that did `const d = new Date(EXPR); … d.toISOString()
     .split('T')[0]` → pass the original **string** to `toDateOnly` (so the
     offset is preserved, not lost to an intermediate `Date`), keeping each
     plugin's own payload prep (epoch-unit detection, text cleaning).
   - Two plugins (`source-jsonld`, `source-ats-workatastartup`) had their own
     private `toDateOnly(value)` method that duplicated the logic; these are
     removed and their single call site routes through the shared helper
     (consolidation, per the no-duplication directive).
   - `source-bdjobs`, `source-naukri`, `source-ats-workday` (whose helpers were
     `Date`-typed and so not caught by the chain match) are routed through
     `toDateOnly` by hand for consistency.
   - 253 call sites across 228 files; ~40 RSS-feed plugins whose local
     `datePosted` is typed `string | undefined` get `?? undefined` to keep that
     type (the helper returns `string | null`).
4. **Tests** — a helper-level suite and a greenhouse service test proving an
   evening offset timestamp keeps the source day; full-graph typecheck
   (`nx build`) plus targeted unit suites for both code families.

## Non-goals

- No change to which source field is chosen (`first_published` → `updated_at`,
  `opened_at` → `created_at` → `updated_at` ordering is unchanged).
- No change to genuinely `Date`-typed query-window math that is *meant* to be
  UTC (it now still goes through `toDateOnly`, which UTC-truncates `Date`
  inputs — behaviour-preserving).
- No changes outside ever-jobs.

## Contracts

- `toDateOnly(value: string | number | Date | null | undefined): string | null`
  exported from `@ever-jobs/common`.
- `JobPostDto.datePosted` stays a `YYYY-MM-DD` string or `null` — shape
  unchanged; only the day value is corrected for offset timestamps.
- No new dependency; no plugin imports another plugin.

## Test plan

- **Helper** — evening negative-offset and morning positive-offset timestamps
  keep their local day; bare date passes through; `Z` stays on its UTC day;
  epoch/`Date` fall back to UTC day; `null`/`''`/invalid → `null`.
- **Greenhouse service** — a posting with
  `first_published: 2026-04-20T22:32:33-04:00` reports `datePosted` `2026-04-20`
  (previously `2026-04-21`).
