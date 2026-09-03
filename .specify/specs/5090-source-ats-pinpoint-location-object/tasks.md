# Tasks: 5090 — Fix Pinpoint location / remote parsing

- [x] T1 — Create Spec Kit files under `.specify/specs/5090-source-ats-pinpoint-location-object/`. Acceptance: spec.md, plan.md, tasks.md present.
- [x] T2 — Update `packages/plugins/source-ats-pinpoint/src/pinpoint.service.ts` to normalize object `location` and safely derive `isRemote`. Acceptance: `tsc` clean.
- [x] T3 — Add `packages/plugins/source-ats-pinpoint/__tests__/pinpoint.service.spec.ts` with mocked `postings.json` fixture. Acceptance: all tests pass.
- [x] T4 — Update `docs/index.md` and `docs/log.md` with Spec 5090. Acceptance: no broken links.
- [x] T5 — Run `tsc --noEmit` and the plugin Jest suite. Acceptance: green.
- [ ] T6 — Push branch and open PR. Acceptance: PR description follows external-audience format.
