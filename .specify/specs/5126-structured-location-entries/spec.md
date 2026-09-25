# Spec 5126 — Structured wire location entries emitted as per-site `locations[]`

| Field | Value |
|---|---|
| Spec | 5126 |
| Slug | `structured-location-entries` |
| Status | in-progress |
| Owner | devin |
| Created | 2026-09-16 |
| Last updated | 2026-09-16 |
| Related specs | 5124 (shared `parseLocationText`/`parseLocationList` rewrite), 5125 (positional-parser swap; deferred list) |

## Problem statement

Spec 5125 deferred 11 plugins whose location handling reads `[0]` (or the first
entry) from a structured multi-site wire field and discards the rest — the same
first-entry-only loss the 5124/5125 plugins had, except the source data is
already structured, so nothing should ever round-trip through text parsing.
Each emits only a merged `location` derived from the first wire entry; every
additional site the board publishes is silently dropped.

## Scope

Rewire the 11 plugins so **every** structured wire location entry maps to
`JobPostDto.locations[]`, while `location` keeps its current value (the
primary/first entry — back-compat output only):

- `altamira` — the board gives one `locationText` per job; emit `locations:
  [location]` (singleton). The slug-tail `Country-Region-City` tokenizer stays:
  it is the wire format, not a display label.
- `bizneo` — `jobLocation` (Place or Place[]) → `addresses()` maps **all**
  `address` nodes; triples thread through `BizneoBoardJob.addresses` →
  `BizneoJob.locationEntries` → `extractLocations()`.
- `cornerstone` — `requisition.locations[]` (array, single object, or display
  string) → `extractLocations()` maps every entry via `locationFromObject`;
  the display-string fallback goes through `parseLocationText`.
- `eightfold` — `standardizedLocations`/`locations` entries (objects or
  `"Country, State, City"` wire-order strings) → `locationEntry()` per entry;
  a string `primaryLocation` falls back to `parseLocationText`.
- `exacthire` — `jobLocation` (Place or Place[]) → `jsonLdAddresses()` maps
  all nodes (string or `{name}` `addressCountry`); `jsonLdAddress` (merged)
  delegates to `[0]`; triples thread via `ExactHireJob.locationEntries`.
- `hreasily` — `jobLocation` (Place or Place[], incl. string `address`) →
  `resolveLocations()` iterates all places; triples thread via
  `HReasilyJob.locationEntries`.
- `icims` — card `location` cells (`|`/`;`-separated `CC-ST-City`) →
  `parseLocations()` parses every cell through the existing `parseLocation`
  (wire order kept — `CC-ST-City` is the wire format); triples thread via
  `IcimsListItem.locationEntries` → `buildLocations()`.
- `inrecruiting` — `jobLocation` Places → `locationEntries()` maps all entries
  including `streetAddress`/`postalCode`; the card free-text fallback goes
  through `parseLocationText`.
- `pcrecruiter` — `jobLocation` Places → `locationEntries()` maps all entries
  including `postalCode`/`streetAddress`; `extractLocations()` applies
  `normaliseCountry`; the listing-label fallback goes through
  `parseLocationText`.
- `prescreen` — `jobLocation` Places → `extractLocations()` maps all entries;
  the listing-label fallback goes through `parseLocationText`.
- `jsonld` — `posting.locations` → `buildLocations()` maps every
  `JobPostingLdLocation` (`city`/`region`→`state`/`country`/`postalCode`); the
  remote flag fills only the first entry's `city` when absent; remote-only
  postings still emit `[{city:'Remote'}]`.

Emit pattern everywhere: `location` = first/merged entry (value unchanged);
`locations` = all wire entries, emitted when at least one resolves.

## Non-goals

- The ~900 plugins that emit `location:{city:wholeLabel}` verbatim — separate
  campaign.
- `indeed` `companyAddresses` (employer display) and `adp`/`breezyhr` per-site
  label composition (the parser's input contract) — untouched by design.
- Parser feature changes — callsite rewiring only.
- `location` value changes — `locations[]` is purely additive.

## Contracts

- Every rewired plugin emits `locations?: LocationDto[]` containing one DTO
  per structured wire entry (plus `[merged]` when only a label fallback
  resolves); `location` keeps its previous value.
- Structured fields map field-to-field — no comma join + re-parse anywhere.
- `country` fields stay literal-only end to end.
- Free-text label fallbacks (board cards, listing labels, display strings)
  delegate to `parseLocationText`, never a positional `split()`.

## Test plan

- New `__tests__/<plugin>.locations.spec.ts` per package: multi-entry wire
  fixtures assert `locations[]` carries every entry; singleton and
  label-fallback paths covered.
- Existing per-plugin suites re-run for all 11 packages.
- `npx tsc --noEmit -p tsconfig.base.json` and `npm run build` clean.
