# Tasks: 5131 — Dash-prefixed US-state sites (`ST - X` / `ST-X`)

- [ ] T1 — `STREET_SUFFIX_RE` + `classifyDashSuffix(rest)` →
      `{city}|{name}`; `splitCityDescriptor(part)` → `{city,name}|null`.
    - Acceptance: `'Gaither Rd.'` → name, `'Boston'` → city,
      `'Rockville Corp Hqtrs'` → `{city:'Rockville', name:'Corp Hqtrs'}`.
- [ ] T2 — `ST -`/`ST-` prefix consumption in the per-part loop (spaced)
      and bare-token path (unspaced, title-case suffix), before
      prefix-country / last-part site-name / alpha-2 paths.
    - Acceptance: `'MA - Boston'` → `{city:'Boston', state:'MA'}`;
      `'MD - Gaither Rd.'` → `{state:'MD', name:'Gaither Rd.'}` (no
      Moldova); `'MA-Boston'` → `{city:'Boston', state:'MA'}`;
      `'CO-OP'`/`'ON - Toronto'` unchanged.
- [ ] T3 — `City <descriptor>` tail split on remaining parts when a
      `ST -` state was claimed; leftovers join `name`.
    - Acceptance: `'MD - Gaither Rd., Rockville Corp Hqtrs'` →
      `{city:'Rockville', state:'MD', name:'Gaither Rd. - Corp Hqtrs'}`;
      `'MA - Boston, Corp Hqtrs'` → `{city:'Boston', state:'MA',
      name:'Corp Hqtrs'}`; bare `'Rockville Corp Hqtrs'` unchanged.
- [ ] T4 — Spec cases + regressions in `location-parser.spec.ts`; common
      jest suite; `tsc --noEmit`; `lint:docs`; docs/index.md + log.md.
    - Acceptance: suite green including all contract rows.
