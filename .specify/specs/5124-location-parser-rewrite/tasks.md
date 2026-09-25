# Tasks 5124 — Location parser rewrite + join-then-reparse caller cleanup

| Field | Value |
|---|---|
| Spec | 5124 |
| Slug | `location-parser-rewrite` |
| Status | in-progress |
| Owner | devin |
| Created | 2026-09-16 |
| Last updated | 2026-09-16 |
| Related specs | 5118, 5119, 5120, 5121, 5122, 5123 |

- [x] **T1** Rewrite `packages/common/src/utils/location-parser.ts` under the
      existing export names with the corpus-validated ruleset (separator
      splitting, comma groups, dash rules, qualifier→flags only, literal-only
      `country`, bare-state resolution default-on minus collisions, Korea alias,
      alpha-3 map, site-descriptor `name`, geo-only merged blob, `text`
      provenance).
      *Acceptance:* new spec file green; `parseLocationText` delegates to
      `parseLocationList` pipeline.
- [x] **T2** Rewrite `packages/common/__tests__/location-parser.spec.ts` — 27
      cases for the approved semantics.
      *Acceptance:* `npx jest packages/common/__tests__/location-parser.spec.ts`
      passes.
- [x] **T3** Rewire array→blob joiners: `google`, `ibm`, `meta`, `talroo`,
      `reliefweb` → `parseLocationList` on the wire array + `locations[]` emit.
      *Acceptance:* no `locations.join(', ')` → `city` path remains.
- [x] **T4** Rewire field→join→reparse: `submit4jobs` (fields → `LocationDto`
      directly, free-text fallback via parser), `canekast` (`normalizeUsState`
      direct DTO), `builtin` + `successfactors` (drop display joins, emit
      `locations` singletons; CSB-tile flat text via `parseLocationText`).
- [x] **T5** Rewire mokahr-family: `mokahr` + `beesite` + `beisen` gain
      `locationEntries` triples threaded through normalized-job types →
      `locations[]`; `beesite`/`mokahr` hand-rolled `splitLocation` bodies
      deleted; `beisen` `LocNames` routed through `parseLocationList`;
      `isolved` + `solides` emit `locations` singletons.
      *Acceptance:* family fixture suites pass; beisen `'China'` → `country`.
- [x] **T6** Rewire hand-rolled `split(',')` parsers: `jobvite` private
      `parseLocationText` deleted, `workingnomads` `parseLocation` deleted,
      `glassdoor.utils` `parseLocation` delegates — all onto the shared parser.
- [x] **T7** Validation: jest on all touched packages (415 tests, 32 suites)
      green after one beisen fixture expectation update; `npm run build`
      (tsc + webpack) clean.
- [x] **T8** Spec docs: `.specify/specs/5124-location-parser-rewrite/{spec,plan,tasks}.md`,
      `docs/index.md` row, `docs/log.md` entry.
- [ ] **T9** Commit on `devin/*` branch off `origin/develop`, push, open PR to
      `develop` (conventional-commit subject).
