# Plan: 5171 — location-object-mapper

| Field | Value |
| --- | --- |
| Spec ID | 5171 |
| Slug | location-object-mapper |
| Status | draft |
| Owner | agent |
| Created | 2026-10-09 |

## Phases

1. **Models**: add `extras?: Record<string, unknown>` to `LocationDto`
   (`packages/models/src/dtos/location.dto.ts`); `OfficeDto` inherits.
2. **Common mapper**: new `packages/common/src/utils/location-object.ts` —
   `toLocationDtos`/`toLocationDto`, selector paths, address descent, alias
   sets, coercion, agreement/conflict machinery (reuse
   `canonicalCountryName`, `normalizeUsState`, `parseLocationList` from
   `location-parser.ts`), carry-all extras with `keep`/`drop`/`extrasLimits`,
   exact dedup. Export from `packages/common/src/utils/index.ts`.
3. **Tests**: `packages/common/__tests__/location-object.spec.ts` — every
   spec example + edge cases.
4. **Dayforce**: `dayforce.service.ts` uses `toLocationDtos` for
   `postingLocations`/`PostingLocations` → `locations[]` + primary; flat
   fallback; new fixture for geo-feed keys.
5. **JSON-LD**: `mapLocations` in `jsonld.ts` reuses mapper; adapter maps
   DTO→`JobPostingLdLocation` (`state`→`region`, label join).
6. **Docs + PR**: `docs/index.md`, `docs/log.md`; jest, tsc, lint:docs;
   branch off `origin/develop`, PR to `develop`.

## Packages touched

- new file: `packages/common/src/utils/location-object.ts`,
  `packages/common/__tests__/location-object.spec.ts`
- edit: `packages/models/src/dtos/location.dto.ts`,
  `packages/common/src/utils/index.ts`,
  `packages/common/src/utils/jsonld.ts`,
  `packages/plugins/source-ats-dayforce/src/dayforce.service.ts`,
  `docs/index.md`, `docs/log.md`
- new fixture: `packages/plugins/source-ats-dayforce/__tests__/fixtures/`

## Risks

- Agreement machinery is the largest surface; keep implementation aligned
  1:1 with the spec examples — they are the acceptance suite.
- JSON-LD contract must not regress: run the full `jsonld.locations.spec.ts`
  + all `.locations.spec.ts` files of JSON-LD plugins after migration.
- `extras` on a serialized DTO must round-trip through cache/API — add a
  JSON round-trip test.
