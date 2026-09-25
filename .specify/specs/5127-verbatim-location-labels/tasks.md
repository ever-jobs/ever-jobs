# Tasks 5127 — Verbatim-label plugins emit parsed `location` + `locations[]`

| Field | Value |
|---|---|
| Spec | 5127 |
| Slug | `verbatim-location-labels` |
| Status | in-progress |
| Owner | devin |
| Created | 2026-09-16 |
| Last updated | 2026-09-16 |
| Related specs | 5124, 5125, 5126 |

- [x] **T1** Classify all 936 verbatim `new LocationDto({city})` emitters by
      shape — dominant const-assigned template / helper-emit structured
      triples / inline-conditional / out-of-scope placeholders.
      *Acceptance:* per-class plugin lists + transform decision per class.
- [x] **T2** Codemod the dominant template (~840 files): `parseLocationList`
      on the label var, conditional `locations[]` emit, `isRemote` OR-merge
      (parens around old expr), import merge. *Acceptance:* no
      `new LocationDto({city: <labelVar>})` remains without a parse call;
      tsc clean.
- [x] **T3** Codemod the ~72 structured-triple helper emitters: hoist
      `const location`, emit `locations: [location]` when non-null.
- [x] **T4** Manual pass on non-template files: `wellfound`,
      `dvinci`, `dice`, `dribbble`, `monster`, `techcareers`,
      `careerbuilder`, `coroflot`, `jobsdb`, `stepstone`; label-fallback
      helpers in `beetween`, `talentsoft`, `zimyo`, `darwinbox`,
      `talentadore`, `talentreef`, `pinpoint` → `parseLocationText`.
- [x] **T5** Update generated spec expectations to the parsed-shape
      contract (literal city pins → parsed city; fixture-name asserts →
      `parseLocationText(<wire>).location?.city`).
- [ ] **T6** `npx tsc --noEmit -p tsconfig.base.json`, all touched
      `__tests__` suites, `npm run lint:docs`, `npm run build` green.
- [ ] **T7** Spec/index/log entries; branch off `origin/develop`; PR to
      `develop`; CI green.
