# Tasks 5163

| Field | Value |
| ----- | ----- |
| Spec | `.specify/specs/5163-adp-detail-throttle-recovery/spec.md` |
| Plan | `.specify/specs/5163-adp-detail-throttle-recovery/plan.md` |

- [ ] T1. `adp.constants.ts`: concurrency 4; recovery constants.
- [ ] T2. `adp.service.ts`: `retries: 0` detail client, `failed`-index
  tracking, serial recovery pass, warn logs.
- [ ] T3. Unit tests per spec test plan (mock `sleep`).
- [ ] T4. `jest` + `tsc --project tsconfig.typecheck.json` + `npm run lint:docs`.
- [ ] T5. `docs/index.md` row, `docs/log.md` prepend; commit, push, PR.
