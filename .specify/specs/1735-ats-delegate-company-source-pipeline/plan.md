# Plan 1735 — ATS-Delegating Company-Source Pipeline

| Field | Value |
| --- | --- |
| Spec | spec.md |
| Created | 2026-09-24 |
| Last updated | 2026-09-25 |

## Approach

1. **Verify before generating.** Hand-curate candidates (owner's company list
   plus well-known Workday tenants), look up each firm's ATS board with web
   search first (no request to the company), then confirm it with a single
   listing request through the polite probe. Only boards with a live record
   ever reach the generator (`assembleDescriptors` refuses the rest).
2. **One generator, all backends.** A `BACKENDS` table carries, per ATS: the
   `Site` key delegated to, the adapter package (tests only), the board input
   field, the adapter's id prefix, the human board URL, the reason the real
   adapter reports for a 404, and a fixture builder that turns the recorded
   listings into the exact HTTP responses the adapter requests.
3. **Batch specs.** Plugins share one spec per batch (1736 Workday, 1737 quant);
   the generator renders the verification table the spec embeds.
4. **Tail wiring.** A new wiring script appends at the tail so the lane's
   changes to the four shared files are pure tail additions.

## Packages / files touched

| Path | Change |
| --- | --- |
| `scripts/probe-ats-delegate-company-source.ts` | new |
| `scripts/scaffold-ats-delegate-company-source.ts` | new |
| `scripts/wire-company-source-tail.ts` | new |
| `scripts/seeds/ats-delegate-companies.json` | new (seed) |
| `scripts/seeds/ats-delegate-company-verification.json` | new (live record) |
| `scripts/__tests__/{probe,scaffold}-ats-delegate-company-source.spec.ts`, `wire-company-source-tail.spec.ts` | new |

## Risks

| Risk | Mitigation |
| --- | --- |
| A Workday tenant migrates cluster (`wd5` → `wd504`) or renames its site | Plugin returns a classified `bad_input`/`fetch_error` diagnostic; re-run the probe and bump the slug in the seed, then re-scaffold. Walmart, Comcast and Expedia were found mid-migration during verification (`wd5` 422 → `wd504`/`wd115`/`wd108`). |
| Load on large Workday tenants | Review follow-up (spec §4.6): the adapter now sends the keyword as `searchText` and enriches details one at a time, 250–500 ms apart (was 5 in flight); pages still sleep 1–2 s. Boards scraped sequentially within a plugin. Per-host / per-cluster pacing is the crawl-policy lane (Spec 1690). See Q-107. |
| A caller's or operator's ATS credential reaching another company's board | Spec §4.5: `auth: undefined` in every delegation; the Greenhouse env Harvest key is scoped to `GREENHOUSE_HARVEST_BOARD`. |
| A host whose robots.txt disallows crawling | Spec §3.1 review; such a plugin is generated explicit-only (§4.7). |
| Concurrent registration edits | Tail append; rebase is keep-both. |
| A recorded fixture drifting from live data | Fixtures are frozen recordings; the suites assert mapping, not live content. |

## Verification

- `npx jest scripts/__tests__/{probe,scaffold}-ats-delegate-company-source.spec.ts scripts/__tests__/wire-company-source-tail.spec.ts`
- `npx tsc --project tsconfig.typecheck.json --noEmit`
- `npm run lint:docs`
