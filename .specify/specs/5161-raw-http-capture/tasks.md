# Tasks 5161

| Field | Value |
| ----- | ----- |
| Spec | `.specify/specs/5161-raw-http-capture/spec.md` |
| Plan | `.specify/specs/5161-raw-http-capture/plan.md` |

- [ ] T1. `raw-capture.interface.ts` in `packages/models` (`RawHttpEntry`,
  `RawCaptureSink`) + export.
- [ ] T2. `request-context.ts`: `rawCapture` field, `runWithRawCapture`,
  `getRawCapture`.
- [ ] T3. `raw-capture.ts` helpers in `packages/common/src/http`: sink
  factory, budgets, UTF-8 truncation, key redaction, shared URL redaction,
  `drainRawCapture`.
- [ ] T4. `http-client.ts`: per-attempt entries, closed-skip, non-2xx bodies,
  `final_url`.
- [ ] T5. `browser-pool.ts`: `attachRawCapture(page)`; wire into `getPage`.
- [ ] T6. `attachRawCapture(page)` calls in `source-tesla-playwright` and
  `source-ats-kula_ai`.
- [ ] T7. `jobs.service.ts`: options param, 400 gate, worker sinks,
  `scrapeOne` sink arg, drain/close/snapshot, `rawBySource`.
- [ ] T8. `jobs.controller.ts`: `include_raw` param, cache-read skip,
  `raw_by_source` emission.
- [ ] T9. Unit tests per spec's test plan.
- [ ] T10. `jest` + `tsc --project tsconfig.typecheck.json` +
  `npm run lint:docs`.
- [ ] T11. Live verify one REST source + one browser source with
  `include_raw`.
- [ ] T12. `docs/index.md` row + footer, `docs/log.md` prepend; commit, push,
  PR to develop.
