# Plan 1736 — Workday Company Sources

| Field | Value |
| --- | --- |
| Spec | spec.md |
| Created | 2026-09-24 |
| Last updated | 2026-09-26 |

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

## Review follow-ups (2026-09-25)

1. Adapter (`source-ats-workday`): trimmed `searchTerm` → `searchText`
   (T6); detail enrichment 1 in flight with a 250–500 ms pause (T8). Adapter
   suite first (red), then the change.
2. Generator: Workday company-name rule (T9) and `auth: undefined`
   (Spec 1735 §4.5); re-scaffold all generated packages (fixtures unchanged),
   re-run every generated suite.
3. **Release ordering (T10, spec §7) — withdrawn by T16 (owner, 2026-09-26):
   the batch ships enabled; the kill switch below is an optional emergency
   lever.** As first planned: this batch merges only after — or
   together with — the ever-hust full-result consumer (NDJSON / all pages).
   Until that consumer is live in production, the deployment must carry the
   batch in `EVER_JOBS_DISABLED_SOURCES` (list in spec §7), otherwise the
   consumer's page 1 of a site-sorted response leads with `3m`.
4. **Per-scrape bound (T11, spec §8; review finding F8):** in
   `source-ats-workday`, cap detail requests per scrape
   (`WORKDAY_MAX_DETAIL_FETCHES`, 50) and bound the whole scrape in time
   (`WORKDAY_SCRAPE_TIME_BUDGET_MS`, 90 s), returning the rest at list level;
   derive a list-level posting's id from the row's requisition id so it matches
   the enriched id; build the list-level URL with the career site. Env readers
   in `workday.constants.ts`; budget cases driven by a fake `Date.now`.
   Documented for operators in `.env.example` and `docs/DEPLOYMENT.md`
   (with the T10 kill-switch list).
5. **Review round 2 (2026-09-26; T12–T16, spec §7, §8.1, §8.2):** in
   `source-ats-workday`, give a posting one identity whether enriched or
   returned at list level — company name = tenant (generator: Workday plugins
   re-stamp the display name like every backend; re-scaffold of the 55
   Workday plugins), the row's place from its location bullet when
   `locationsText` is missing, a single US-state site implying the country;
   keep departments out of `additionalLocations`; accept a bullet as the
   requisition id only when the path carries it; cap the time budget at 3/4
   of the fan-out deadline read from `EVER_JOBS_FANOUT_DEADLINE_MS` /
   `EVER_JOBS_SEARCH_DEADLINE_MS`. Tests on the recorded Moderna page and
   detail (`__tests__/fixtures/moderna-*.json`), each new rule
   mutation-checked. Docs: the batch ships enabled (owner), the kill switch is
   an optional emergency lever; consumers key Workday postings on `id`.
6. **List-level dates on the board's calendar (2026-09-26; T17, spec §8.1):**
   in `source-ats-workday`, `resolveWorkdayBoardToday` dates the board from
   the scrape's enriched postings (row label + detail `startDate`) and the
   relative labels count back from that date instead of UTC's. Tests on a
   recording of Moderna's first page and all 20 details taken after UTC
   midnight, and in six host time zones through a ts-node child process
   (Jest sandboxes `process.env`, so `TZ` cannot move inside a test).
