# Plan 1737 — Quant / Trading-Firm Company Sources

| Field | Value |
| --- | --- |
| Spec | spec.md |
| Created | 2026-09-24 |
| Last updated | 2026-09-25 |

## Approach

1. Start from the owner's list of 40 firms; identify each firm's platform by
   web search first (no request to the firm), preferring a supported ATS.
2. Verify each identified board with one listing request through the Spec 1735
   probe (<= 1 req/s, honest UA, <= 3 requests per firm).
3. Seed the verified firms (`specNo: 1737`, `segment: quant-trading`), scaffold,
   tail-wire.
4. Record every uncovered firm and the reason (spec §3, Q-109) instead of
   writing bespoke scrapers against sites without a simple public listing.

## Files

| Path | Change |
| --- | --- |
| `packages/plugins/source-company-<key>/*` (31 packages) | new |
| `packages/models/src/enums/site.enum.ts`, `packages/plugins/index.ts`, `tsconfig.base.json`, `jest.config.js` | tail additions |

## Verification

- Generated suites green; `npx tsc --project tsconfig.typecheck.json --noEmit` clean.
