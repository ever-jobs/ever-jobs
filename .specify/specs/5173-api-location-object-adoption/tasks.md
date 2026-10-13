# Tasks: 5173 — api-location-object-adoption

- [x] 1. Spec artifacts (spec.md, plan.md, tasks.md) + docs index/log rows.
- [x] 2. gem — `toLocationDtos(posting.locations, { textKeys: ['name'], parseTextFallback: true })`;
      `location` = first result; `locations[]` = all results (deliberate key
      change → release note); remote checks unchanged; drop orphaned
      `parseLocationList` import.
- [x] 3. recruitly — `toLocationDto(item.location, { aliases: { state: ['regionName'] } })`;
      carry the mapped DTO through the normalised job (postalCode,
      streetAddress, extras survive); `location`/`locations:[location]` shape
      preserved.
- [x] 4. arbeitsagentur — `toLocationDto(entry.arbeitsort, { aliases: { state: ['region'] } })`;
      keep `homeOffice` → `isRemote`; dto-presence shape preserved.
- [x] 5. cornerstone — `toLocationDtos(requisition.locations ?? requisition.location, { textKeys: ['displayName'], parseTextFallback: true })`;
      keep `displayLocation` fallback + `detectRemote`; delete dead
      `locationFromObject`.
- [x] 6. Tests — gem fixture assertions (multi-site locations[]), recruitly +
      arbeitsagentur captured fixtures, cornerstone key-change tests;
      all existing suites pass unmodified.
- [ ] 7. Verify — scoped + full affected jest, `tsc`, `lint:docs`; docs/log.md
      + docs/index.md; branch, conventional commit, PR with release note.
