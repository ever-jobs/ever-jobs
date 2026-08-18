# Plan: 1680 — Diagnostics semantics, and the two backends that gate 300 wrappers

| Field        | Value        |
| ------------ | ------------ |
| Spec         | spec.md      |
| Created      | 2026-08-18   |
| Last updated | 2026-08-18   |

## Approach

First of a five-PR sequence. Deliberately small (~8 files) and fully reviewable, because every later
PR hard-codes the answers settled here — the reason vocabulary, the inference rule, and whether
plugins resolve or throw. Getting those wrong and then applying them across 1,500 files is the
expensive mistake this ordering exists to avoid.

Measure, then change. The census behind this work counted all 1,839 plugin services and classified
every error-handling shape, rather than extrapolating from the canonical example.

## Steps

1. **Widen `ScrapeReason`** with `partial` and `not_registered`, and add both to
   `ACTIONABLE_SCRAPE_REASONS` so they survive Spec 1679's default filter. Verified the union has no
   exhaustive consumer before widening it.
2. **Close the 4xx gap** in `classifyScrapeError`, preserving rule order so 403/429 keep their
   existing (correct) classifications.
3. **Infer `partial`** at the fan-out, so a non-zero count with a diagnostic stops reading as `ok`.
4. **Derive the Prometheus status from the diagnostic**, not from the promise settling. Without this
   the whole migration improves one JSON field and leaves every dashboard wrong.
5. **Fix the two silent backends**, which unblocks ~295 delegating wrappers with zero edits to them.

## Testing

The census surfaced the trap that shapes the test strategy: **1,505 generated specs assert
`result.jobs` only**, so they stay green regardless of what a plugin reports. A green suite is not
evidence this works. The tests added here are the only ones in the repo that would fail if the
contract regressed:

- `packages/models/__tests__/scrape-diagnostics.spec.ts` — the 4xx matrix, plus explicit
  non-regression cases pinning 403 → `blocked` and 429 → `fetch_error`.
- `apps/api/src/jobs/__tests__/jobs.service.spec.ts` — `partial` / `ok` / `empty` / propagated
  reason, and three assertions on the Prometheus label including that it stays `success` when no
  diagnostic is reported.

## Editing mechanics

The tree is mixed-EOL: **293 CRLF files, 154 with a BOM**, and no `.gitattributes` or `.editorconfig`
to normalize it. `scrape-diagnostics.dto.ts` is pure CRLF. Git Bash strips CR in text mode, which is
how this went unnoticed and why a naive LF-anchored regex matches only 805 of the 822 canonical files.

All edits here were applied by a line-anchored editor that reads bytes, matches on content with the
CR stripped, and restores the original line ending on write. Every file was checked with
`git diff --numstat` against `git diff --ignore-all-space --numstat`; identical counts prove no
whitespace or EOL churn. The same machinery is the basis for the later codemod.

## Rollout

Source-only. No migration, no schema, no wire-format change, no new secret. A clean `git revert`
restores the previous behaviour.
