# Tasks: 1697 — French/EU contract vocabulary for job types

- [x] T1 — `PERMANENT` and `APPRENTICESHIP` appended to `JobType`. Acceptance: `Object.values(JobType)` keeps the ten existing values in order and ends with `permanent`, `apprenticeship`; every member resolves to itself.
- [x] T2 — `normalizeJobTypeKey` shared by aliases and inputs; index built once. Acceptance: all 44 legacy aliases and their upper-case / capitalised / spaced / hyphenated variants resolve to the same member as the old resolver (literal copy of the old table and function in the suite); normalisation is idempotent and never empties an alias.
- [x] T3 — New aliases in natural spelling (FR/EU contract, part-time counterparts, freelancing, apprenticeship). Acceptance: the EU label table in the suite resolves; `findJobTypeAliasCollisions()` is `[]` and reports a planted collision (control).
- [x] T4 — `stage` locale-scoped to fr/nl/it. Acceptance: `null` without a locale and for `en`/`de`; `INTERNSHIP` for `fr`, `fr-FR`, `FR`, `fr_BE`, `nl`, `it`.
- [x] T5 — Token mode + `JOB_TYPE_PROSE_AMBIGUOUS` (`permanent`, `temp`, `interim`, `seasonal`, `other`, `temporal`, `vast contract`). Acceptance: `null` in token mode, the member in label mode.
- [x] T6 — Null-safe resolver; non-object options ignored. Acceptance: `null`, `undefined`, `''`, `'  - _ '`, a number, and `.map(getJobTypeFromString)` all behave.
- [x] T7 — `getJobTypesFromString` composite helper with the full-coverage n-gram fallback and a 256-character whole-value-only cap. Acceptance: the plan's composite table row for row; a pathological separator run finishes well under 500 ms.
- [x] T8 — Compile-forced label maps (argospace, atlasspace, launchpadbuild_ai) and the hlaboratories label switch. Acceptance: a `Permanent` / `Apprenticeship` chip or field yields its member and label (new synthetic suites).
- [x] T9 — Prose scanners (atlasspace, launchpadbuild_ai) resolve in token mode via `jobTypeScanOptions(process.env)`; `EVER_JOBS_JOB_TYPE_SCAN_MODE=label` restores the legacy scan. Acceptance: prose with "early-stage", "permanent residency", "temp-to-perm", "interim", "other duties" yields `[FULL_TIME]`; the label-mode control yields the extra legacy types.
- [x] T10 — Stale underscore comments corrected in solidjobs, gusto-hosted and jsonld; code kept (no-removal).
- [x] T11 — CLI `--job-type` help derived from the enum (`search`, `compare`); `docs/CLI.md` lists the values and the permanent-vs-fulltime semantics.
- [x] T12 — Live drift spec `wttj-contract-vocabulary.e2e-spec.ts`: one facet-only request with an honest User-Agent and no retries; every `contract_type` key resolves or is known-unmapped (`vie`, `graduate_program`, `idv`); outages are logged and tolerated.
- [x] T13 — Regression: unit suites of all 52 plugins that call `getJobTypeFromString` (50 suites, 643 tests) green.
- [x] T14 — `getEnumFromJobType(str, options?)` pass-through in `packages/common/src/utils/helpers.ts`. Dropped from this lane: the file carries another lane's large in-progress change and the function has no callers. One-line follow-up.

Integration 2026-09-25: T14 done: `getEnumFromJobType(str, options?)` passes the options through (`packages/common/__tests__/get-enum-from-job-type.spec.ts`).
