# Tasks: 5130 — Location parser: US state names, territories, and dotted codes

- [x] T1 — `US_TERRITORY_NAMES` + `US_TERRITORY_DISPLAY_NAMES` +
      `usSubdivision(value)`; dot-strip in `normalizeUsState`.
    - Acceptance: `usSubdivision('Puerto Rico')` → `'Puerto Rico'`;
      `normalizeUsState('D.C.')` → `'DC'`; `normalizeUsState('N.Y.')` →
      `'NY'`.
- [x] T2 — Wire `usSubdivision` into `parseSingleLabel` (fused slot, bare
      token), `parseCommaParts` (trailing-state, `X, Country` city slot
      with `BARE_STATE_NAME_COLLISIONS` exemption, single-part path), and
      the per-part fused re-check.
    - Acceptance: `'Arizona, USA'` → `{ state: 'AZ', country: 'United States' }`;
      `'Puerto Rico, USA'` → `{ state: 'Puerto Rico', country: 'United States' }`;
      `'Puerto Rico'` → `{ state: 'Puerto Rico' }`;
      `'New York, USA'` stays `{ city: 'New York', ... }`.
- [x] T3 — `bareLabelWithStateSuffix` for `'City ST'` labels; wire into
      both single-token paths and the `X, Country` city slot.
    - Acceptance: `'Bristol RI'` → `{ city: 'Bristol', state: 'RI' }`;
      `'Washington D.C'` → `{ city: 'Washington', state: 'DC' }`.
- [x] T4 — `impliedCountry` + `tryCommaGroupSplit` firm check recognize
      territory display names.
    - Acceptance: `'Bristol, RI, Washington, D.C'` splits into
      `{Bristol,RI}` + `{Washington,DC}`; `'X, Puerto Rico'` is a firm pair.
- [x] T5 — Spec cases in `location-parser.spec.ts`; run common jest suite,
      `tsc --noEmit`, `lint:docs`; update `docs/index.md` + `docs/log.md`.
    - Acceptance: suite green including new cases; typecheck clean.
