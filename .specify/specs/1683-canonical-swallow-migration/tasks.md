# Tasks: 1683 — 822 services stop swallowing their errors

- [x] T1 — Probe the population and its encoding before writing the transform. Acceptance: 822 anchor matches agreeing with the census independently; **822/822 are CRLF**, 16 with a BOM — so byte-level handling is the only thing that works here, not a precaution.
- [x] T2 — `scripts/codemod/canonical-swallow-diagnostics.ts`: validating transform for the 822 services. Acceptance: dry run `transformed=822 corrupt=0`, skip reasons only `ALREADY_MIGRATED`/`DELEGATING`/`NO_ANCHOR`.
- [x] T3 — Preconditions that license passing `jobs` rather than `[]`: exactly one `jobs` declaration, exactly one `return { jobs };`, ordering `decl < try < catch`, and `jobs.push(` inside the try. Acceptance: all 822 pass independently — the accumulator is filled inside the try and the catch is outside the loop, so partial results already flow and emitting `[]` would be silent data loss.
- [x] T4 — Keep plugins resolving, never throwing. Acceptance: the breaker counts failures only on rejection, so this cannot trip one; making 822 plugins throw would trip breakers on any 403 source within five fan-outs and overflow `MAX_SITES = 250` against 1,832 sites.
- [x] T5 — `scripts/codemod/canonical-swallow-specs.ts`, gated on the sibling service carrying the new catch. Acceptance: 806 transformed, 52 skipped `SERVICE_NOT_MIGRATED` — 809 specs match the anchor but only 806 belong to migrated services, and asserting `fetch_error` against a still-swallowing service would look like a real regression.
- [x] T6 — Apply both passes. Acceptance: 822 services uniformly `+7/-1`, 806 specs uniformly `+3/0`, zero outliers; both diff forms report 1,628 (no EOL churn).
- [x] T7 — Sabotage verification: revert one migrated service to the swallow and confirm its spec FAILS (`Expected: "fetch_error", Received: undefined`). Restored, and the diff distribution re-checked to prove no residue.
- [x] T8 — `tsc --noEmit` clean; targeted suites green across migrated packages.
- [x] T9 — Docs: `.specify` spec/plan/tasks, `docs/index.md` row + footer, `docs/log.md` entry; `lint:docs` clean.

## Notes

**No bot review:** 1,628 files exceeds Greptile's 100-file limit. The mechanical gates and the
two-shape diff carry the weight.

**16 canonical services have no spec at all** — `stripe`, `openai`, `amazon`, `apple`, `boeing`,
`cursor`, `google`, `ibm`, `meta`, `microsoft`, `netflix`, `nvidia`, `uber`, `zoom`, plus
`source-ats-comeet` and `source-ats-pinpoint`. They are covered only by
`apps/api/src/jobs/__tests__/jobs.service.spec.ts`.

**Deliberately left for PR 5:** `source-company-tiktok`, the one canonical-bucket file whose nested
try/finally fails the anchor — it gets a hand edit rather than a forced regex — along with the
268-file tail, which must be clustered by exact catch-tail and dry-run per cluster. Roughly 128 of
those return `[]` from the catch and need the accumulator hoisted out of the `try` *before* the
rewrite, and `source-ats-rippling` carries the one spec assertion in the repo
(`.resolves.toEqual({ jobs: [] })`) that will actually break.
