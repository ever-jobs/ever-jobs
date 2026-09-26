# Spec: 1697 — French/EU contract vocabulary for job types

| Field          | Value                     |
| -------------- | ------------------------- |
| Spec ID        | 1697                      |
| Slug           | eu-contract-job-types     |
| Status         | done                      |
| Owner          | agent                     |
| Created        | 2026-09-25                |
| Last updated   | 2026-09-25                |
| Supersedes     | (none)                    |
| Related specs  | (none)                    |

## 1. Problem Statement

French and wider EU job sources describe employment with a contract vocabulary that
`getJobTypeFromString()` did not know, so `jobType` came back `null` for most of their rows:
`CDI`, `CDD`, `Intérim`, `Stage`, `Alternance`, `Freelance`, `Indépendant`, `Temps partiel`,
`Temps complet`, `befristet`, `Ausbildung`, and snake-case tokens such as `full_time`.

The resolver itself had six weaknesses:

1. Underscores were not stripped, so five plugins carried their own `replace(/_/g, …)`
   workaround (one of them, `replace('_', '')`, only removed the first underscore).
2. Aliases had to be typed already normalised, so `'temps partiel'` could never match.
3. Accents had to match exactly (`interim` vs `intérim`).
4. It threw on `null` / `undefined`.
5. It scanned every alias list on every call.
6. Two company plugins feed it every word and word pair of prose sections. Adding the obvious
   new aliases naively would turn "early-**stage** startup", "U.S. citizenship or **permanent**
   residency" and "and **other** perks" (all present in our own fixtures) into job types.

A live probe of the French board index (2026-09-24, facet-only query, honest User-Agent)
returned 11 `contract_type` tokens over 90,117 rows; only 3 of them resolved before this spec
(`temporary`, `internship`, `other`).

## 2. Decisions

- **D-01 — Two new members, appended.** `PERMANENT = 'permanent'` (open-ended employment, the
  duration axis, orthogonal to hours: "CDI, Temps partiel" is permanent *and* part-time) and
  `APPRENTICESHIP = 'apprenticeship'` (paid work-study contracts, often 1–3 years; folding them
  into `INTERNSHIP` would hide a large category). Appended so no existing wire value or OpenAPI
  position moves.
- **D-02 — No `FREELANCE` member.** `CONTRACT` already carries `contractor`, and
  `source-upwork` already maps freelance engagements to it. `freelance`, `indépendant`,
  `self-employed` and `auto-entrepreneur` become `CONTRACT` aliases.
- **D-03 — One normaliser for aliases and inputs.** `normalizeJobTypeKey`: NFD, drop the Latin
  combining-diacritic block, NFC, lower-case, then strip whitespace, hyphens/dashes, `_`, `.`,
  apostrophes, `/` and parentheses. It strips a strict superset of the old `[\s-]`, so every
  input that matched before still produces its alias's key (proved by the legacy regression
  test). `%` is kept (`100%`). The index is built once at module load.
- **D-04 — `stage` is locale-scoped.** It is "internship" in French, Dutch and Italian and an
  ordinary English word, so it resolves only with `{ locale: 'fr' | 'nl' | 'it' }` (primary
  subtag, case-insensitive; `fr-FR`, `FR`, `fr_BE` all count).
- **D-05 — Token mode for prose scanners.** `{ mode: 'token' }` ignores the prose-ambiguous
  aliases `permanent`, `temp`, `interim`, `seasonal`, `other`, `temporal` and `vast contract`.
  The two scanner plugins use it. `temporal` ("temporal resolution") and `vast contract` ("a
  vast contract portfolio") were added to the set during implementation after checking which
  new aliases are also ordinary English words or word pairs.
- **D-06 — The legacy scan stays reachable.** `EVER_JOBS_JOB_TYPE_SCAN_MODE=label` makes the
  scanners trust every word again (read per scrape through `jobTypeScanOptions(process.env)`).
- **D-07 — A composite helper.** `getJobTypesFromString` resolves labels that combine facets
  ("CDI, Temps plein", "Contract/Temp", "Apprentissage - 24 Mois"). It tries the whole value,
  then primary segments (`, ; | + & • ·`), then `/`, stand-alone dashes and conjunctions, and
  finally a full-coverage n-gram walk in which every word must be an alias or a noise word (a
  number, `35h`, a duration unit, or a short connector such as `de` / `à` / `of`). "permanent
  residency" therefore yields nothing. Values over 256 characters are only tried whole. All
  splitting is plain character classes or word tests: no backtracking regex.
- **D-08 — Collisions are a test failure, not a runtime throw.** `findJobTypeAliasCollisions()`
  reports any key two members claim (globally and per locale); lookups keep the first member.
- **D-09 — Filters.** `ScraperInputDto.jobType` is `@IsEnum(JobType)`, so the API, CLI and
  OpenAPI accept the new values with no further change. LinkedIn has no job-type code for them
  (`jobTypeCode` returns `null`, `f_JT` is not sent, as for `perdiem` today); Indeed forwards the
  raw value; ZipRecruiter's map yields an empty `employment_type`. No change needed in any of
  them.
- **D-10 — No-removal.** The five plugin-side underscore workarounds stay (now redundant); only
  their comments were corrected.

## 3. Non-goals

- Wiring each French/EU source to emit `jobType` from its contract field (one follow-up per
  source; none needs a new request).
- `extractJobType()` (description keyword scan) stays English-only: French words such as
  "stage" are too ambiguous in running text.
- No `vie` / `graduate_program` / `idv` mapping in core; a source can map them locally.

## 4. Acceptance

- Every legacy alias (44) and its upper-case / capitalised / spaced / hyphenated variants
  resolve to the same member as before.
- `findJobTypeAliasCollisions()` is `[]`; a planted collision is reported (control).
- `CDI`, `Contrat à durée indéterminée`, `Permanent`, `Permanent Contract`, `Unbefristet` →
  `PERMANENT`; `CDD`, `Befristet`, `Freelance`, `Indépendant` → `CONTRACT`; `Intérim`,
  `Saisonnier` → `TEMPORARY`; `Alternance`, `Apprentissage`, `Contrat d'apprentissage`,
  `Cont. professionnalisation`, `Ausbildung` → `APPRENTICESHIP`; `Temps partiel`, `Deeltijd`
  → `PART_TIME`; `Temps complet` → `FULL_TIME`; `full_time`, `FULL_TIME`, `per_diem` resolve.
- `Stage` is `null` without a locale and with `en`/`de`, `INTERNSHIP` with `fr`, `fr-FR`, `FR`,
  `nl`, `it`.
- In token mode the ambiguous aliases give `null`; in label mode they resolve.
- `null`, `undefined`, `''`, separator-only strings and a numeric options argument give `null`
  (no throw).
- The composite table in the plan resolves row for row, including `U.S. citizenship or
  permanent residency` → `null` and `early stage startup` (fr) → `null`.
- The scanner plugins return `[FULL_TIME]` for prose containing "early-stage", "permanent
  residency", "temp-to-perm", "interim" and "other duties"; with
  `EVER_JOBS_JOB_TYPE_SCAN_MODE=label` the same prose yields the legacy extra types (control).
- The live drift spec finds every French-index `contract_type` key resolved or known-unmapped.
