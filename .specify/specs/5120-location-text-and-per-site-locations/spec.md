# Spec 5120 — `LocationDto.text` (verbatim label) + per-site `locations[]` in six plugins

| Field | Value |
|---|---|
| Spec | 5120 |
| Slug | `location-text-and-per-site-locations` |
| Status | implemented |
| Owner | devin |
| Created | 2026-09-14 |
| Last updated | 2026-09-14 |
| Related specs | 5119 (`rippling-structured-locations`), 5118 (`ats-posting-country-code`) |

## Problem

Two distinct losses of information in the shared location path:

1. **The raw label is destroyed by parsing.** `parseLocationText` ends with
   `return { location: new LocationDto({ city: normalized }) }` — anything it
   cannot split lands wholesale in `city`, so `{city: "Berlin, Germany"}` and
   `{city: "Washington D.C, Los Angeles, CA"}` claim to be cities. Callers
   that could parse the label better than we do never see it, because the
   original string is gone by the time the DTO is built.

2. **Site boundaries are discarded at the DTO boundary.** `parseLocationList`
   already computes a per-site `LocationDto[]`, but every plugin except
   `source-ats-rippling` (Spec 5119) keeps only the merged singular
   `location`, whose `city` is a `A; B` join. A consumer cannot recover the
   site boundaries from that string: commas are the *intra*-site delimiter
   (`City, ST`) and semicolons the *inter*-site one, so a label that already
   contains a comma-joined pair is indistinguishable from one multi-part
   place name.

## Scope

- `packages/models` — add `LocationDto.text?: string | null`: the source's raw
  location label, recorded verbatim before parsing. Purely additive;
  `displayLocation()` is unchanged and ignores it.
- `packages/common` — `parseLocationList` records the normalized label on
  every concrete per-site location it produces
  (`new LocationDto({ ...location, text: normalized })`). `city` keeps exactly
  the value it has today, so no existing consumer changes behavior.
- Wire `JobPostDto.locations` through the six plugins that feed
  `parseLocationList` a genuine multi-label list and discarded the result:
  `source-ats-lever`, `source-ats-workday`, `source-ats-breezyhr`,
  `source-ats-gusto-hosted`, `source-ats-workatastartup`,
  `source-company-aurora_tech`.
  `source-ats-gusto-hosted` additionally maps its JSON-LD sites structurally
  (each `jobLocation` entry → one `LocationDto`) rather than rebuilding a
  label for the parser to re-split.

## Non-goals

- `city` semantics are unchanged. Moving the unparsed label out of `city`
  would blank the MCP tool output, the CLI location column, the analytics
  location facet (jobs with no `city` are skipped) and part of the dedup key.
  That remains a future breaking change, viable once consumers read `text`.
- The merged multi-site `location` gets **no** `text`: its `city` is
  synthesized by us (`labels.join('; ')`), not raw from the source.
- Plugins that join structured fields into a label and then re-parse their own
  composition (`source-ats-adp`, `source-ats-ashby`) and the inverse
  packed-entry problem in `source-ats-greenhouse` are each their own spec.
- `parseLocationList`'s US-only `commonCountry` derivation (a posting with US
  and non-US sites can still be stamped `United States`) is unchanged here.
- The ~19 callers that pass a single label are skipped: their `locations`
  would be `[location]`, adding no information.

## Contracts

| Input labels | `location` (unchanged) | `locations` (new) |
|---|---|---|
| `["Seattle, WA"]` | `{city:"Seattle",state:"WA",text:"Seattle, WA"}` | same single entry |
| `["Bengaluru"]` | `{city:"Bengaluru",text:"Bengaluru"}` | same single entry |
| `["Washington D.C","Los Angeles, CA"]` | `{city:"Washington D.C; Los Angeles, CA"}` — no `text` | `[{city:"Washington D.C",text:"Washington D.C"},{city:"Los Angeles",state:"CA",text:"Los Angeles, CA"}]` |
| `["Remote","United States"]` | `{country:"United States"}`, `isRemote` | none — no site label |

For a single-site posting the parser returns the same object as both
`location` and `locations[0]`, so the singular `location` also carries `text`.
`text` is therefore emitted by every `parseLocationList` caller, not just the
six plugins wired for `locations[]` — additive in all of them.

`text` is the label *as fed to the parser*, i.e. after the plugin's own
normalization (Workday `_` → space, gusto-hosted `<br>` split,
workatastartup `/` split). It is never shorter than `city`, which is either a
substring of it or the identical string on the fallback path.

## Test plan

- `packages/common`: `text` recorded on parsed, partially parsed and unparsed
  entries; present on the singular location for a single-site posting; absent
  on the merged multi-site location and on remote-only/country-only results.
- Each of the six plugins: a multi-site posting emits `locations[]` with the
  expected per-site `city`/`state` and the verbatim `text`, while the existing
  singular-`location` expectations continue to pass unchanged.
