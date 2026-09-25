# Spec: 5145

| Field | Value |
| ----- | ----- |
| Spec ID | 5145 |
| Slug | eightfold-http-error-fallback |
| Status | Done |
| Owner | Devin (for MakeDeeply) |

## Problem statement

Spec 5138 added a PCSX-search fallback for tenants that gate
`/api/apply/v2/jobs`. The fallback only triggers when the gated request
succeeds with a non-payload body (`{"message": "Not authorized for
PCSX"}`). Real gated tenants — e.g. `careers.gf.com` — answer **403**:
`client.get` throws, propagates out of `fetchPage`, and the whole scrape
returns `JobResponseDto([])` with a fetch diagnostic — the open
`/api/pcsx/search` path is never tried. Verified live: GF serves 524
positions anonymously via pcsx/search while apply/v2 is 403.

## Scope

- `fetchPage`: wrap the `client.get` + `unwrapPositionsAndCount` for each
  candidate path in try/catch. On error, record it and continue to the
  next path; when a path yields a payload, remember it (`jobsPath`) and
  return as today.
- If every candidate path throws, rethrow the **last** error so a genuine
  outage still surfaces as a classified diagnostic — never a silent empty
  board.
- When `jobsPath` is already resolved, behavior is unchanged: the single
  remembered path's error propagates.

## Non-goals

- No new endpoints or response shapes; both envelopes already handled.
- No change to partial-results semantics (mid-scrape errors still slice
  + classify via the outer catch).

## Contracts

- 403 on `/api/apply/v2/jobs` + 200 on `/api/pcsx/search` → jobs return
  normally; `jobsPath` resolves to pcsx for subsequent pages.
- Errors on all paths → the last error propagates to `scrape`'s outer
  catch → `classifyScrapeError` diagnostic.

## Test plan

- Unit: apply/v2 throws 403 → pcsx succeeds → positions returned and
  `jobsPath` set to the pcsx path; all-paths-fail → the last error
  surfaces as diagnostics; 200-with-gate-JSON still falls through (5138
  regression).
- `npx jest source-ats-eightfold`, `npx tsc --project
  tsconfig.typecheck.json --noEmit`, `npm run lint:docs`.
