# Spec: 1699 — Country coverage: Slovenia's code, Sri Lanka, the ISO 3166 table

| Field          | Value                          |
| -------------- | ------------------------------ |
| Spec ID        | 1699                           |
| Slug           | country-coverage-iso3166       |
| Status         | done                           |
| Owner          | agent                          |
| Created        | 2026-09-25                     |
| Last updated   | 2026-09-25                     |
| Supersedes     | (none)                         |
| Related specs  | 1689                           |

## 1. Problem Statement

The location parser only knew the ~76 countries of `COUNTRY_CONFIG` by name. Every other
country name fell through to the verbatim-subdivision branch, so a label such as
`Almaty, Kazakhstan` came back as `{ city: 'Almaty', state: 'Kazakhstan' }`, and
`Colombo, Western Province, Sri Lanka` came back as one unparsed `city` blob. On the 91
distinct labels of one live company board (official public board API, probed 2026-09-24,
three requests with an honest user agent), 17 entries had a country in `state` and 3 had the
wrong country.

Four root causes:

1. **Slovenia's code.** `COUNTRY_CONFIG[SLOVENIA].indeed` was `'sl'`. `SL` is Sierra Leone, so
   every `Slovenia` / `Ljubljana, Slovenia` / `Remote - Slovenia` label displayed as
   *Sierra Leone*, `canonicalCountryName('Slovenia')` disagreed with
   `canonicalCountryName('SI')`, `source-indeed` sent `indeed-co: SL`, and the GraphQL
   `country: 'SL'` resolved to Slovenia. A guard over the whole table shows Slovenia was the
   only entry whose code names another country.
2. **Configured-only name lookup.** `normalizeCountryOnly` resolved names only through
   `COUNTRY_CONFIG`; only the alpha-2 path (`regionNameFromCode`) knew every country, so `LK`
   worked and `Sri Lanka` did not.
3. **Alpha-3 spellings diverged.** `COUNTRY_ALPHA3` held hand-typed names (`CZE` ->
   `Czech Republic`, `TUR` -> `Turkey`, `HKG` -> `Hong Kong`) while the name path emitted the
   CLDR spellings (`Czechia`, `Türkiye`, `Hong Kong SAR China`), so dedup keys built from the
   two forms disagreed. Only the configured countries had an alpha-3 at all.
4. **US towns named after countries.** `Peru, IN`, `Mexico, MO` and `Poland, OH` read as
   `{ country, state }`. A wider name map would have spread that to ~250 names
   (`Lebanon, PA`, `Jamaica, NY`), so the widening needs guards.

`Sri Lanka` was also not an accepted input `country` (`countryFromString('sri lanka')` threw).

## 2. Goals

- Slovenian locations say **Slovenia**; Sierra Leone keeps its own name and code.
- Every ISO 3166-1 country name, alpha-2 code and upper-case alpha-3 code is recognised in a
  location label, and all three forms canonicalise to one display name.
- `Sri Lanka` is an accepted input country (`Country.SRILANKA`, code `LK`).
- No regression for US labels: US towns named after countries, the US state `Georgia` and the
  US territories keep their US reading.
- The pre-change lookup stays reachable (owner rule: no removed behaviour).

## 3. Non-Goals

- No new source plugin, no network code, no crawl-policy change.
- No Indeed-market validation. Bangladesh, Bulgaria, Croatia, Cyprus, Estonia, Latvia,
  Lithuania, Malta, Slovakia, Slovenia and now Sri Lanka are input countries without an Indeed
  host (their subdomains have no DNS record). Tracked as follow-up F1.
- No change to the display of configured countries (`Hong Kong SAR China` stays). F2.
- `README.md` "Supported Countries" table and the `source-company-wolt` fixture assertion are
  left to the integrator (outside this lane's files).

## 4. User / Caller Stories

> As a **consumer of `JobPostDto.location`**, I want **`Colombo, Western Province, Sri Lanka`**
> to come back as `{ city, state, country: 'Sri Lanka' }`, so that **country filters and
> facets work for every country, not only the configured markets**.

> As the **dedup stage**, I want **`SVN`, `SI` and `Slovenia` to canonicalise to one name**, so
> that **the same posting from two sources keys the same**.

> As an **operator**, I want **`EVER_JOBS_LOCATION_ISO_COUNTRY_NAMES=false`** to restore the
> configured-only reading, so that **I can roll the change back without a deploy of code**.

## 5. Functional Requirements

| ID    | Requirement | Priority |
| ----- | ----------- | -------- |
| FR-1  | `COUNTRY_CONFIG[SLOVENIA].indeed` is `'si'`. | must |
| FR-2  | `Country.SRILANKA` with names `sri lanka,srilanka` and code `lk`. | must |
| FR-3  | `packages/common/src/utils/iso3166.ts`: frozen `ISO_ALPHA2_TO_ALPHA3` / `ISO_ALPHA3_TO_ALPHA2` (249 official codes + `XK`/`XKX`), plus `isoAlpha3FromAlpha2` / `isoAlpha2FromAlpha3`. No display names stored. | must |
| FR-4  | The parser resolves every ISO country NAME (CLDR spelling, folded diacritics and apostrophes, `&`/`and`, `St.`/`Saint`, parenthesised variants, board aliases such as `Ivory Coast`, `Burma`, `Macedonia`, `The Netherlands`) after the configured names. | must |
| FR-5  | Non-configured alpha-3 codes resolve only as an upper-case token and never for the ambiguous list (`AND`, `MAC`, `VAT`, `IOT`, `ETH`, `NAM`, `MCO`, US territories, …). Configured alpha-3 codes stay case-insensitive. | must |
| FR-6  | Name, alpha-2 and alpha-3 of a country emit the same display name; `CD`/`CG`/`MM` use re-parse-safe overrides (`DR Congo`, `Republic of the Congo`, `Myanmar`). | must |
| FR-7  | US guards: a leftover part after a US-state tail is a town (`Lebanon, PA`) unless the tail code is that country's own code (`India, IN`); US-territory names and `Georgia` never read as countries by name; `Tbilisi, Georgia` is the country only next to a known Georgian place. | must |
| FR-8  | A `&` / `and` inside a comma part that is a whole country name is not a site connector (`Sarajevo, Bosnia & Herzegovina`). | should |
| FR-9  | CLDR's own `Congo - Kinshasa` is one name, not `X - site`. | should |
| FR-10 | `ParseLocationOptions.isoCountryNames` (default true; env `EVER_JOBS_LOCATION_ISO_COUNTRY_NAMES`) — false restores the pre-1699 lookup, alpha-3 spellings, US-town and Georgia readings. `normalizeCountryOnly` / `canonicalCountryName` take it as an optional second argument. | must |
| FR-11 | `getCountryDisplayName` capitalises every word (`Sri Lanka`, `Costa Rica`). | could |

## 6. Non-Functional Requirements

| ID     | Requirement | Target |
| ------ | ----------- | ------ |
| NFR-1  | Per-label parse cost | within noise of the pre-change parser (measured 36–41 µs/label both) |
| NFR-2  | Name map build | once at module load, ~250 `Intl.DisplayNames.of` calls |
| NFR-3  | Connector check | linear in label length, also with `maxLabelLength: 0` |

## 7. Contracts

### 7.1 API / Interface

```ts
// packages/common/src/utils/iso3166.ts
export const ISO_ALPHA2_TO_ALPHA3: Readonly<Record<string, string>>;
export const ISO_ALPHA3_TO_ALPHA2: Readonly<Record<string, string>>;
export function isoAlpha3FromAlpha2(code: string | null | undefined): string | null;
export function isoAlpha2FromAlpha3(code: string | null | undefined): string | null;

// packages/common/src/utils/location-parser.ts
interface ParseLocationOptions { isoCountryNames?: boolean; /* … */ }
LOCATION_PARSER_ENV.isoCountryNames === 'EVER_JOBS_LOCATION_ISO_COUNTRY_NAMES';
function normalizeCountryOnly(value: string, options?: Pick<ParseLocationOptions, 'isoCountryNames'>): string | null;
function canonicalCountryName(value: string | null | undefined, options?: Pick<ParseLocationOptions, 'isoCountryNames'>): string | null;

// packages/models/src/enums/country.enum.ts
Country.SRILANKA; // COUNTRY_CONFIG: { names: 'sri lanka,srilanka', indeed: 'lk' }
```

### 7.2 Errors

None. Unknown values keep returning `null`.

## 8. Test Plan

- Unit (`packages/common/__tests__/iso3166.spec.ts`): table size, bijection, frozen, every
  alpha-2 resolves through CLDR, pseudo/retired codes absent, case-insensitive helpers; every
  `COUNTRY_CONFIG` code names its own country (red for SLOVENIA before the fix), codes unique,
  Sri Lanka accepted, display-name capitalisation.
- Unit (`packages/common/__tests__/location-parser.spec.ts`): the label table; a row per ISO
  country (name / alpha-2 / alpha-3 agree, `Someplace, <name>` parses and re-parses to itself);
  the exact unresolved alpha-3 set; pseudo-region names; `&` names; canonical agreement;
  Slovenia vs Sierra Leone; US towns (2- and 3-part), `India, IN`, `United States, CA`,
  Georgia; the legacy option and env; trimmed live-board labels.
- Red control: the new suites run against the pre-change parser and enum fail 256 cases, all
  in the Spec 1699 blocks; the 156 pre-existing cases stay green.
- Regression: all `packages/common` and `packages/models` suites, the `apps/api` jobs suites and
  35 plugin suites that parse locations.
- Performance: connector check on 44k-character uncapped labels under 500 ms.

## 9. Open Questions

Follow-ups for the integrator (not decided here):

- **F1** `source-indeed` builds job URLs on hosts with no DNS record for the eleven non-market
  input countries. Mark them in `COUNTRY_CONFIG` and return a `bad_input` diagnostic without a
  request.
- **F2** Display `Hong Kong` / `Macao` instead of the CLDR `… SAR China` — a second, deliberate
  dedup-key drift, so its own change.
- **F3** `source-ats-isolved` hand-rolls a partial alpha-3 map; it can use `iso3166.ts`.
- **F4** `source-himalayas` pages by the deprecated `offset`; the feed prefers `?cursor=`.
- **F5** (pre-existing, found while probing) `parseLocationList` keeps only the FIRST
  country-only site of a label: its city|state dedup key is empty for every country-only entry,
  so `Germany; France` and `Serbia and Montenegro` yield one entry. Fixing it changes
  `locations[]` for every plugin, so it needs its own spec and an option.

## 10. Decisions

- **D-01 — Display names are never stored.** The ISO table holds codes only; names come from
  `regionNameFromCode` (CLDR), so one country has one spelling in every path.
- **D-02 — Names only after the configured map.** Configured names keep their existing display;
  the ISO map only answers what used to be a miss.
- **D-03 — Three display overrides.** `Congo - Kinshasa` (reads as `X - site`) and
  `Myanmar (Burma)` (reads as a qualifier) would not survive a re-parse of an emitted label.
- **D-04 — Upper-case only for new alpha-3 codes, with an ambiguity list.** A lower-case `and`
  or an upper-case `ETH`, `NAM` or `MCO` is a word, an abbreviation or an airport before it is a
  country. The legacy configured codes keep their case-insensitive reading.
- **D-05 — Georgia by context.** The name `Georgia` never reads as the country by itself; the
  existing "collision names stay cities" test pins the bare label. A trailing `Georgia` next to
  a Georgian city or region is the country; `Tbilisi, GE` already resolved through alpha-2.
- **D-06 — The US-town guard keeps `India, IN`.** When the tail code is the leftover country's
  own code the label names the country twice, so the old `{ state, country }` reading stays.
- **D-07 — One option gates the whole change.** `isoCountryNames: false` (or the env var)
  restores the pre-1699 lookup, including the alpha-3 spellings and the US-town reading. The
  Slovenia code is a data fix and applies in both modes.
- **D-08 — One-time dedup key drift.** Slovenian rows keyed `…|Sierra Leone`, `CZE`-sourced
  `Czech Republic` rows and country-as-state rows get new canonical keys on their next ingest,
  then merge from there on. Worth one line in the PR description.
- **D-09 — The live labels are inlined, trimmed.** 45 of the 91 probe labels are in the spec as a
  constant rather than a fixture file, which keeps this lane to its own files.

## 11. References

- `packages/common/src/utils/location-parser.ts` — `normalizeCountryWith`, `ISO_COUNTRY_NAME_DISPLAY`,
  `countryNamePartChecker`, the Georgia rule and the US-town guard in `parseCommaParts`.
- `packages/common/src/utils/iso3166.ts`, `packages/models/src/enums/country.enum.ts`.
- `packages/common/src/canonical-key.ts` — the dedup consumer of `canonicalCountryName`.
