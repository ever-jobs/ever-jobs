# Tasks: 5172 — jsonld-joblocation-mapper

- [x] 1. Write spec.md + plan.md + tasks.md for 5172.
- [x] 2. Adopt `toLocationDtos` — first-Place-only plugins (21): akkencloud,
  arcoro, brassring, careerplug, concludis, hireful, hron, jobtrain, keka,
  mindscope, namely, otys, pageup, paychex, peoplestrong, rexx, scouttalent,
  snaphunt, taleez, vivahr, workforce + the `[location]`-single-element
  group (cezanne, expr3ss). Skipped as out-of-scope: isolved (location comes
  from the jobs API, not `jobLocation`), stepstone (location parsed from DOM
  text, no structured `jobLocation` branch).
  Acceptance: `location` from `toLocationDto(jobLocation)`; fallbacks intact.
- [x] 3. Adopt `toLocationDtos` — per-site plugins (6): bizneo, exacthire,
  hreasily, inrecruiting, pcrecruiter, prescreen.
  Acceptance: `locations = toLocationDtos(jobLocation)`; `location = dtos[0]`.
- [x] 4. Remove dead helpers where fully unused (firstAddress/countryName);
  keep where remote-detection or fallbacks still use them.
- [x] 5. Run per-plugin jest suites — zero test modifications, all green.
- [ ] 6. `npx tsc -b` clean; `npm run lint:docs` clean; docs/index.md row +
  docs/log.md entry.
- [ ] 7. Branch off develop, commit, push, open PR to develop.
