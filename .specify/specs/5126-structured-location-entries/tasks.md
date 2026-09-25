# Tasks 5126 — Structured wire location entries emitted as per-site `locations[]`

| Field | Value |
|---|---|
| Spec | 5126 |
| Slug | `structured-location-entries` |
| Status | in-progress |
| Owner | devin |
| Created | 2026-09-16 |
| Last updated | 2026-09-16 |
| Related specs | 5124, 5125 |

- [x] **T1** Audit the 11 deferred plugins' wire shapes — every one reads
      `[0]`/first from a structured multi-site field; `altamira` is a
      singleton (`locations: [location]`). *Acceptance:* emit shape per plugin
      decided.
- [x] **T2** Rewire all 11 plugins: `bizneo`, `exacthire`, `hreasily`, `icims`,
      `inrecruiting`, `pcrecruiter` thread `locationEntries` triples through
      their normalized-job types; `cornerstone`, `eightfold`, `prescreen`,
      `jsonld` map their wire arrays directly; `altamira` emits
      `locations: [location]`. Label fallbacks delegate to `parseLocationText`;
      bespoke wire-order parsers (`altamira` slug-tail, `icims` `CC-ST-City`,
      `eightfold` `Country, State, City`) kept. *Acceptance:* no plugin reads
      only `[0]` from a structured location array; `location` value unchanged.
- [x] **T3** Add `__tests__/<plugin>.locations.spec.ts` for all 11 packages —
      multi-entry fixtures, singleton emit, label fallback. *Acceptance:* 34
      new tests green.
- [ ] **T4** Spec/index/log entries; `npx tsc --noEmit -p tsconfig.base.json`,
      all 11 suites, `npm run build` green; PR to `develop`; CI green.
