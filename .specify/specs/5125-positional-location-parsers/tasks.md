# Tasks 5125 — Positional location-label parsers swapped onto the shared parser

| Field | Value |
|---|---|
| Spec | 5125 |
| Slug | `positional-location-parsers` |
| Status | in-progress |
| Owner | devin |
| Created | 2026-09-16 |
| Last updated | 2026-09-16 |
| Related specs | 5124 |

- [x] **T1** Inventory: classify every private `split()`/`parts[i]` location
      parser — 59 swaps, 11 deferrals (group-3 structured multi-site wire data:
      `bizneo`, `cornerstone`, `eightfold`, `exacthire`, `hreasily`, `icims`,
      `inrecruiting`, `pcrecruiter`, `prescreen`, `jsonld`; `altamira` slug
      tokenizer). *Acceptance:* every positional label→`LocationDto` parser
      accounted for.
- [x] **T2** Rewire the 59 plugins: `applicantpro`, `applicantstack`, `applied`,
      `apploi`, `avionte`, `brassring`, `breathehr`, `catsone`, `clearcompany`,
      `cleverconnect`, `digitalrecruiters`, `elmo`, `employmenthero`, `emply`,
      `eploy`, `factorial`, `gohire`, `greeting`, `harri`, `hireserve`,
      `hrpartner`, `jobadder`, `jobdiva`, `jobsoid`, `jobtoolz`, `livehire`,
      `niceboard`, `oleeo`, `paycor`, `peoplefluent`, `peoplehr`, `personio`,
      `phenom`, `polymer`, `radancy`, `recruitis`, `softy`, `teamdash`,
      `trackerrms`, `tribepad`, `umantis`, `vincere`, `workstream`,
      `androidjobs`, `authenticjobs`, `bdjobs`, `careeronestop`, `amazon`,
      `argospace`, `boeing`, `microsoft`, `nvidia`, `thinkorbital`, `zoom`,
      `devopsjobs`, `naukri`, `powertofly`, `solidjobs`, `themuse` — private
      positional bodies deleted, `locations[]` emitted per Spec 5124 emit
      pattern. *Acceptance:* no `parts[i]`→`city/state/country` assignment
      remains for location labels; `parseLocationText`/`parseLocationList`
      imported from `@ever-jobs/common`.
- [x] **T3** Judgment calls: inferred `USA`/`US` stamps removed (`amazon`,
      `argospace`, `thinkorbital` + `resolveStateName`/`US_STATE_ABBREVIATIONS`
      deleted); `bdjobs`/`naukri` board-level country fallbacks kept;
      `harri`/`workstream` prose-regex feed `parseLocationText`; `greeting`
      token pre-checks retained.
- [x] **T4** Tests: jest across the 59 touched plugin packages — 281 tests /
      59 suites green; `argospace`/`thinkorbital` `country:'USA'` expectations
      updated to undefined (literal-only).
- [x] **T5** `tsc --noEmit -p tsconfig.base.json` clean (null-tightening on
      `harri` tuple, missing `location` hoists on radancy/softy/teamdash/
      trackerrms resolved).
- [x] **T6** Spec docs: this dir, `docs/index.md` row, `docs/log.md` entry.
- [ ] **T7** Commit on `devin/*` branch off `origin/develop`, push, open PR to
      `develop` (conventional-commit subject).
