# Tasks 5171 — Generic location-object mapper + LocationDto.extras

- [ ] 1. Add `extras?: Record<string, unknown>` to `LocationDto`
  (`packages/models/src/dtos/location.dto.ts`).
      Acceptance: `OfficeDto` inherits; JSON serialize/deserialize keeps it.
- [ ] 2. Implement `toLocationDtos`/`toLocationDto` in
  `packages/common/src/utils/location-object.ts`; export via utils index.
      Acceptance: selector paths, address descent, aliases, coercion,
      agreement/conflict, extras filters+limits, dedup per spec.
- [ ] 3. Unit tests `packages/common/__tests__/location-object.spec.ts`:
  all spec agreement/conflict examples, casing, US equivalence, ambiguous
  keys→extras, extras limits/filters/collisions/cycles, dedup, bounds.
      Acceptance: `npx jest location-object` green.
- [ ] 4. Migrate Dayforce `extractLocation` → `toLocationDtos` for
  `postingLocations`/`PostingLocations`; primary `location` = first usable;
  flat-field fallback; add sanitized geo fixture with multi-site posting.
      Acceptance: `npx jest source-ats-dayforce` green; city/country/
  formattedAddress/multi-site recovered; remote checks unchanged.
- [ ] 5. Reuse mapper inside `mapLocations` in `jsonld.ts`; preserve
  `JobPostingLdLocation` contract (`state`→`region`, label join, array
  expansion, postal-only, `addressCountry.name` conflict preference).
      Acceptance: `npx jest jsonld` + JSON-LD plugin `*.locations.spec.ts`
  green.
- [ ] 6. `npm run tsc` + `npm run lint:docs` clean; `docs/index.md` +
  `docs/log.md` updated; commit, push, PR to `develop`.
      Acceptance: PR open with green local checks.
