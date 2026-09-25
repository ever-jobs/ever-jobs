# Plan: 1699 — Country coverage: Slovenia's code, Sri Lanka, the ISO 3166 table

| Field        | Value      |
| ------------ | ---------- |
| Spec ID      | 1699       |
| Status       | done       |
| Last updated | 2026-09-25 |

## Approach

Core only (`packages/models` + `packages/common`); no plugin changes are forced, because every
plugin reaches countries through `parseLocation*`, `normalizeCountryOnly` or
`canonicalCountryName`, whose signatures only gain an optional argument.

1. **Enum.** Fix Slovenia's code to `si`; add `SRILANKA` after `SPAIN` (the enum is
   alphabetical). `COUNTRY_CONFIG` is the only exhaustive `Record<Country, …>`; the Adzuna and
   Careerjet maps are `Partial` and fall back. `getCountryDisplayName` title-cases each word.
2. **ISO table.** A new `iso3166.ts` with the 250 alpha-2 -> alpha-3 pairs as a frozen literal
   grouped by initial letter, its frozen inverse and two case-insensitive helpers; exported
   from the utils barrel.
3. **Name map.** Beside `COUNTRY_NAME_DISPLAY`, built once: for each ISO code (minus the US
   territories and `GE`), the lookup keys of its CLDR name and of its display name
   (`isoNameKeys`: folded, dot-less, `&`/`and`, `St`/`Saint`, parenthesised variants,
   `… SAR China`), then the board aliases. `MAX_COUNTRY_NAME_LENGTH` bounds the connector check.
4. **Lookup.** `normalizeCountryOnly` becomes `normalizeCountryWith(value, iso)`: configured
   name -> ISO name (fold only for non-ASCII input) -> alpha-2 (with overrides) -> alpha-3
   (legacy codes case-insensitive with ISO display; others upper-case only, minus the ambiguity
   list). With `iso` false it is byte-for-byte the old lookup. Every internal call goes through
   `countryIn(value, opts)`; `isMiddleRegionCode` and `usStateTailWins` take `opts`.
5. **Parser guards** in `parseCommaParts`: the dash-prefix country uses `countryByNameOnly`
   (names only, as before); a part that is itself a country name containing ` - ` is not split;
   the Georgia rule runs before the merged-blob and US-subdivision steps; the single-leftover
   branch skips the country reading after a tail-popped US state unless the state code is that
   country's own code.
6. **Connectors.** `tryWordSplit` skips a connector whose comma part is a whole country name,
   through a forward-only checker created on the first connector (linear, no slice past the
   longest name).
7. **Option.** `isoCountryNames` in `ParseLocationOptions`, `LOCATION_PARSER_ENV`, the resolved
   options and the env cache; default true.

The existing 3-part tail veto already skips the city slot (`usStateTailWins`, Spec 1689), so
`Lebanon, Boone County, IN` and friends needed regression cases only, not a code change.

## Files

| File | Change |
| ---- | ------ |
| `packages/models/src/enums/country.enum.ts` | Slovenia `si`, `SRILANKA`, word-capitalised display name |
| `packages/common/src/utils/iso3166.ts` | new ISO 3166-1 table + helpers |
| `packages/common/src/utils/index.ts` | export `iso3166` |
| `packages/common/src/utils/location-parser.ts` | name map, lookup, guards, connector check, option |
| `packages/common/__tests__/iso3166.spec.ts` | new: table + `COUNTRY_CONFIG` code guard |
| `packages/common/__tests__/location-parser.spec.ts` | new Spec 1699 blocks |

## Verification

- `npx jest --testPathPatterns "packages/common/__tests__/(location-parser|iso3166|canonical-key)"`
- all `packages/(common|models)/__tests__`, `apps/api/src/jobs/__tests__`, and 35 plugin suites
  that parse locations (ATS: ashby, bamboohr, cleverconnect, greenhouse, isolved, jobvite,
  lever, personio, pinpoint, rippling, umantis, workday; sources: adzuna, glassdoor, habrcareer,
  headhunter, indeed, linkedin; and 22 company plugins whose fixtures carry the affected
  country names).
- Red control: the new spec against the pre-change parser + enum in a scratch harness.
- `npx tsc --project tsconfig.typecheck.json --noEmit`.
- Bench (scratch harness, 48k parses): 36–41 µs/label before and after.
