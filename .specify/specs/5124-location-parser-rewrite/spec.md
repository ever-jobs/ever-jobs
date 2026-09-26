# Spec 5124 — Location parser rewrite + join-then-reparse caller cleanup

| Field | Value |
|---|---|
| Spec | 5124 |
| Slug | `location-parser-rewrite` |
| Status | in-progress |
| Owner | devin |
| Created | 2026-09-16 |
| Last updated | 2026-09-16 |
| Related specs | 5118–5123 (per-site `locations[]`/`offices[]`, `LocationDto.text`/`name`) |

## Problem statement

`parseLocationText` / `parseLocationList` (packages/common) had grown piecemeal:
labels with `;` / `|` separators, comma-packed multi-site lists, `(N)` serial markers,
`Hybrid`/`Remote` qualifiers fused into geography, and non-US country spellings
(alpha-2/alpha-3) all landed in `city` blobs or were silently dropped. `state` carried
mixed codes and full names; `country` fields were inconsistent about whether implied
geography could stamp them. Separately, ~17 source plugins joined structured
location fields (or whole `locations[]` arrays) into a single comma string and then
either re-parsed that string by hand (`split(',')`) or stuffed it into `location.city` —
fabricating a blob that destroyed the per-site structure the upstream payload already
carried.

## Scope

1. Rewrite `parseLocationText` / `parseLocationList` with the rules validated against a
   harvested corpus of real board labels (~2,006 unique label sets):
   - **Separators.** `;` and `|` always split; `&`, `/`, `and`, `or` split only when
     every part validates as firm geography (`and`/`or` require all parts firm;
     `&`/`/` allow bare title-case cities when at least one part is firm).
     ALL-CAPS 2-letter tokens are never treated as word connectors or qualifier
     words (`'Portland, OR / Hybrid'` keeps `OR` as Oregon).
   - **Comma groups.** Width-3 triples and width-2 pairs are recognised as
     `City, ST[, Country]` sites even when packed into one label.
   - **Dashes.** `Country - X`, `X - Country`, `X - <workplace qualifier>`, and
     trailing `X - <site name>` peel per comma part.
   - **Qualifiers.** `Hybrid`/`Remote`/`On-site`/`(N)` markers (parens, fused
     `Remote City`, `X-Remote` affixes) feed the remote/hybrid flags only — they
     never mint `city`/`name`.
   - **State.** US codes pass through; US names map to codes (name→code only);
     non-US subdivisions stay verbatim; typos stay verbatim. Bare state names
     resolve to `state` by default (`allowBareStateProvince !== false`) except the
     city-name collisions `{washington, new york, georgia}`, which stay `city`.
   - **Country.** `COUNTRY_CONFIG` names + `'korea'`→`'South Korea'` alias + ISO
     alpha-2 + explicit alpha-3 map (71 entries). `country` fields are **literal
     only**: an implied country (e.g. `TX`→`US`) may veto a conflicting literal
     stamp but never creates one — no inferred `country` anywhere.
   - **Name.** Only site-descriptor tokens (`hq|hqtrs|headquarters|office|campus|
     corp(orate)?|site|plant|services|pvt|ltd|inc|factory|facility|works|onsite|
     offsite`) earn `name`; qualifier text never does.
   - **Merged `location`.** Back-compat only: verbatim-but-geo-only label blob in
     `city` (literal-country segments stripped, qualifiers and `(N)` removed),
     `country` stamped only when exactly one literal country appears and no entry
     conflicts. `text` is recorded only when the label is not trivially
     regenerable from the parsed fields.
2. Rewire the 17 plugins that join-then-reparse or cram arrays into a blob so
   per-site structure flows into `LocationDto` / `locations[]` directly:
   `google`, `ibm`, `meta`, `talroo`, `reliefweb`, `builtin`, `successfactors`
   (3 sites), `submit4jobs`, `canekast`, `mokahr`, `beesite`, `solides`, `beisen`,
   `isolved`, `jobvite`, `workingnomads`, `glassdoor`.

## Non-goals

- The remaining plugins whose private `split(',')` parsers do positional
  city/state/country on a single label (themuse, solidjobs, powertofly, naukri,
  zoom, thinkorbital, nvidia, microsoft, boeing, argospace, amazon, careeronestop,
  bdjobs, authenticjobs, workstream, vincere, varbi, tribepad, umantis, trackerrms,
  teamdash, softy, recruitis, radancy, prescreen, polymer, phenom, etc.) — a
  follow-up spec will swap them onto the shared parser.
- `adp`/`breezyhr` per-site *label composition* (`City, ST` strings fed to the
  label parser) — that is the parser's input contract, not a lossy join.
- `indeed` `companyProfile.locations.join` — an employer-address display field,
  not the job location.
- Fetch/scrape of live boards; acceptance is the fixture suite + corpus diff.

## Contracts

- `parseLocationText(raw, options?) → { location, remoteMentioned, workFromHomeType, … }`
  — same signature; `location` now delegates through the full `parseLocationList`
  pipeline so single labels get word-splitting, group-splitting, and qualifier peeling.
- `parseLocationList(labels, options?) → { location, locations, remoteMentioned,
  workFromHomeType, labels, … }` — same signature; `locations[]` entries carry
  `city|state|country|name|text`; merged `location` follows the literal-country rule.
- `ParseLocationOptions.allowBareStateProvince` — now **defaults on**
  (`!== false`); callers may still pass `false`.
- `normalizeUsState`, `normalizeCountryOnly` — same signatures, wider coverage.
- `JobPostDto.locations` — emitted by rewired plugins whenever ≥1 entry exists.

## Test plan

- `packages/common/__tests__/location-parser.spec.ts` — 27 cases covering the
  separator matrix, comma groups, dash rules, qualifier peeling, bare-state
  resolution + opt-out + collisions, literal-country merged stamps, `text`
  provenance, and `locations[]` entry shapes.
- Per-plugin fixture suites re-run for all 18 touched packages; the beisen
  fixture expectation updated (`'China'` → `country`, not `state`).
- `npm run build` (tsc/webpack across api, cli, mcp) clean.
