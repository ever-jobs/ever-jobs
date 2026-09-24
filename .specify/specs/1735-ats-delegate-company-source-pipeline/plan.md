# Plan 1735 — ATS-Delegating Company-Source Pipeline

| Field | Value |
| --- | --- |
| Spec | spec.md |
| Created | 2026-09-24 |
| Last updated | 2026-09-24 |

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
| Load on large Workday tenants | Inherited from the adapter (page sleep 1–2 s, detail concurrency 5, capped by `resultsWanted`); per-host pacing is the politeness lane's crawl policy. Boards scraped sequentially within a plugin. See Q-107. |
| Concurrent registration edits | Tail append; rebase is keep-both. |
| A recorded fixture drifting from live data | Fixtures are frozen recordings; the suites assert mapping, not live content. |

## Verification

- `npx jest scripts/__tests__/{probe,scaffold}-ats-delegate-company-source.spec.ts scripts/__tests__/wire-company-source-tail.spec.ts`
- `npx tsc --project tsconfig.typecheck.json --noEmit`
- `npm run lint:docs`
