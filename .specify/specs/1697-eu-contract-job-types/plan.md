# Plan: 1697 — French/EU contract vocabulary for job types

| Field        | Value      |
| ------------ | ---------- |
| Spec ID      | 1697       |
| Status       | done       |
| Last updated | 2026-09-25 |

## Approach

One core file carries the whole change. `job-type.enum.ts` gains the two members, a single
normaliser, alias tables written in natural spelling, a prebuilt `Map` index (global plus one
per locale), the lookup options, the composite helper and the collision detector. Everything is
re-exported through `packages/models/src/enums/index.ts` (`export *`), so no barrel changes.

`getJobTypeFromString(value, options?)` keeps its first parameter and return type and adds an
optional second one, so all ~60 plugin call sites compile unchanged. A non-object second
argument (the index from `.map(getJobTypeFromString)`) is ignored.

The plugin changes are the ones the new members or the resolver force:

1. The three exhaustive `Record<JobType, string>` label maps (argospace, atlasspace,
   launchpadbuild_ai) get `Permanent` / `Apprenticeship`; the build fails without them.
2. The two prose scanners (atlasspace, launchpadbuild_ai) resolve their unigrams and bigrams
   with `jobTypeScanOptions(process.env)` — token mode by default, the legacy label mode with
   `EVER_JOBS_JOB_TYPE_SCAN_MODE=label`. `launchpadbuild_ai`'s whole employment-type chip stays
   in label mode.
3. `hlaboratories` resolves a whole `employment_type` field and its label switch fell back to
   "Full time" for any unlisted member, so it gets the two labels too.
4. The underscore-workaround comments in solidjobs, gusto-hosted and jsonld said the shared
   resolver does not strip underscores; they now say it does. Code unchanged (no-removal).
5. The CLI `--job-type` help on `search` and `compare` is derived from `Object.values(JobType)`
   so it cannot drift again; `docs/CLI.md` lists the values.

## Composite table (`getJobTypesFromString`)

| Input | Options | Result |
| --- | --- | --- |
| `CDI, Temps plein` / `CDI - Temps plein` / `CDI à temps plein` | – | `[permanent, fulltime]` |
| `Temps plein - CDI` | – | `[fulltime, permanent]` |
| `Full-time, Permanent` / `Permanent Full Time` | – | `[fulltime, permanent]` / `[permanent, fulltime]` |
| `Contract/Temp` | – | `[contract, temporary]` |
| `Part-time / Temporary`, `Full-time or Part-time`, `Tiempo completo y tiempo parcial` | – | two types each |
| `Apprentissage - 24 Mois`, `Apprentissage 24 Mois`, `Contrat de professionnalisation 12 mois` | – | `[apprenticeship]` |
| `CDD (6 mois)`, `CDD 35h`, `CDD de 6 mois` | – | `[contract]` |
| `Stage - 4 Mois`, `Stage 6 mois` | `{ locale: 'fr' }` | `[internship]` |
| `Stage` | – | `null` |
| `Freelance / Indépendant`, `Contractor - W2` | – | `[contract]` |
| `Full Time (40 hours)` | – | `[fulltime]` |
| `Summer Internship` | – | `[summer, internship]` |
| `Permanent Contract` | – | `[permanent]` |
| `U.S. citizenship or permanent residency` | – | `null` |
| `early stage startup` | `{ locale: 'fr' }` | `null` |
| `Estágio/Trainee` | – | `[fulltime]` (legacy alias, whole value first) |
| `Permanent, Full-time` | `{ mode: 'token' }` | `[fulltime]` |

## Files

| File | Change |
| ---- | ------ |
| `packages/models/src/enums/job-type.enum.ts` | members, normaliser, tables, index, options, composite helper, collision detector, scan-mode helper |
| `packages/models/__tests__/job-type.enum.spec.ts` | new suite |
| `packages/plugins/source-company-argospace/src/argospace.service.ts` | two labels |
| `packages/plugins/source-company-atlasspace/src/atlasspace.service.ts` | two labels, token-mode scan |
| `packages/plugins/source-company-launchpadbuild_ai/src/launchpadbuild_ai.service.ts` | two labels, token-mode scan |
| `packages/plugins/source-company-hlaboratories/src/hlaboratories.service.ts` | two labels |
| `packages/plugins/source-solidjobs/src/solidjobs.service.ts`, `source-ats-gusto-hosted/src/gusto-hosted.service.ts`, `source-jsonld/src/jsonld.service.ts` | comment only |
| `packages/plugins/source-company-{argospace,atlasspace,launchpadbuild_ai,hlaboratories}/__tests__/*.spec.ts` | new synthetic suites |
| `packages/plugins/source-ats-wttj/__tests__/wttj-contract-vocabulary.e2e-spec.ts` | new live drift spec (one request) |
| `apps/cli/src/commands/{search,compare}.command.ts` | `--job-type` help derived from the enum |
| `docs/CLI.md` | value list |

Not changed, by decision (spec D-09): `source-linkedin` `JOB_TYPE_CODES` (no code exists for the
new values), `source-indeed` (forwards the raw value), `source-ziprecruiter` (its map falls back
to an empty filter; its single-underscore `replace` is now harmless because the resolver strips
the rest).

## Verification

The new models suite, the four plugin suites above, the unit suites of all 52 plugins that call
`getJobTypeFromString`, the live drift spec once, and `tsc --project tsconfig.typecheck.json`.
