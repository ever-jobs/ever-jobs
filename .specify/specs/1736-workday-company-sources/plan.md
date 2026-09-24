# Plan 1736 — Workday Company Sources

| Field | Value |
| --- | --- |
| Spec | spec.md |
| Created | 2026-09-24 |
| Last updated | 2026-09-24 |

## Approach

1. Candidate list: the owner's list of US employers plus well-known Workday
   tenants (Broadcom, Pfizer, Marvell, General Motors, Warner Bros. Discovery,
   Moderna) to make up for the companies that turned out not to be on Workday.
2. Tenant / cluster / site lookup by web search (no request to the company),
   then one verification request each through the Spec 1735 probe; failed
   guesses (HTTP 422) were re-looked-up and re-probed within the 3-request
   budget.
3. Seed entries in `scripts/seeds/ats-delegate-companies.json` (`specNo:
   1736`), then `scaffold-ats-delegate-company-source.ts` and
   `wire-company-source-tail.ts`.

## Files

| Path | Change |
| --- | --- |
| `packages/plugins/source-company-<key>/*` (53 packages) | new |
| `packages/models/src/enums/site.enum.ts` | 53 members appended at the tail |
| `packages/plugins/index.ts` | 53 imports + modules appended at the tail |
| `tsconfig.base.json`, `jest.config.js` | 53 aliases / mappers appended after the last company entry |

## Verification

- `npx jest --runTestsByPath packages/plugins/source-company-<key>/__tests__/<key>.service.spec.ts …`
- `npx tsc --project tsconfig.typecheck.json --noEmit`
