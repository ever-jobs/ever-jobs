# Spec 5125 — Positional location-label parsers swapped onto the shared parser

| Field | Value |
|---|---|
| Spec | 5125 |
| Slug | `positional-location-parsers` |
| Status | in-progress |
| Owner | devin |
| Created | 2026-09-16 |
| Last updated | 2026-09-16 |
| Related specs | 5124 (shared `parseLocationText`/`parseLocationList` rewrite) |

## Problem statement

Fifty-nine source plugins still parse location labels positionally: each keeps a
private helper that `split()`s the label on `,`, `-`, `|`, `;`, or whitespace and
assigns `parts[i]` to `city`/`state`/`country` by index. That approach silently
misattributes fields whenever a label deviates from the expected shape
(`'Denver, CO, US'`, multi-site lists, qualifier-affixed labels), drops remote
detection entirely, and duplicates the parsing rules Spec 5124 consolidated into
`packages/common`. It also means every fix to the shared parser must be re-ported
by hand.

## Scope

Swap every remaining positional label→`LocationDto` parser onto the shared
parser and emit `locations[]` whenever at least one parsed entry exists:

- Helpers replaced by `parseLocationText(label).location` (single label) or
  `parseLocationList(labels)` (label arrays such as microsoft/nvidia/zoom/
  themuse/solidjobs `locations`/`locationsRaw` name lists); private
  `splitLocation`/`parseLocation`/`extractLocation` positional bodies deleted.
- `JobPostDto` gains `locations: [location]` (singleton) or the parsed list
  alongside the existing merged `location` — matching the Spec 5124 emit pattern.
- Tuple-signature helpers kept where the shape feeds a filter (`authenticjobs`
  `{city,state}` reuse) or normalized-job fields (`umantis`/`trackerrms`
  `{city,state,country}` triples) — body now delegates to the shared parser.
- Prose-regex extractors (`harri`, `workstream`) keep their address-regex
  pre-extraction but feed the matched substring to `parseLocationText`;
  hardcoded `country:'US'`/`'GB'` stamps removed (literal-only rule).
- `greeting` keeps its Korean-country-token and remote-token pre-checks; the
  geographic remainder is parsed by the shared parser.
- Inferred country stamps removed per the literal-only rule: `amazon` `?? 'US'`,
  `argospace`/`thinkorbital` `Country.USA`. Board-level constants kept as
  fallback (`bdjobs` → `Country.BANGLADESH`, `naukri` → `Country.INDIA`).

### Deferred (not touched)

Plugins whose label parse also carries structured multi-site wire data (a
group-3 follow-up) or by-design exceptions (Spec 5124): `altamira`, `bizneo`,
`cornerstone`, `eightfold`, `exacthire`, `hreasily`, `icims`, `inrecruiting`,
`pcrecruiter`, `prescreen`, `jsonld`.

## Non-goals

- The ~900 plugins that emit `location:{city:wholeLabel}` verbatim with no
  parse — a separate campaign.
- Composite non-location `split()` parsers (`applicantpro` keyword format,
  `umantis` title `|` split, `androidjobs`/`devopsjobs` title formats) — only
  their extracted *city token* now passes through the shared parser.
- Parser feature changes — callsite swaps only.

## Contracts

- Every rewired plugin emits `location` (merged, Spec 5124 semantics) and
  `locations?: LocationDto[]` when ≥1 entry parses.
- No plugin retains a private `parts[i]`→`city/state/country` positional
  assignment for location labels.
- `country` fields remain literal-only end to end; no plugin re-adds inferred
  stamps.

## Test plan

- Per-plugin fixture suites re-run for all 59 touched packages.
- `argospace`/`thinkorbital` expectations updated: `country` no longer stamped
  `USA` (literal-only).
- `npm run build` (tsc/webpack) clean.
