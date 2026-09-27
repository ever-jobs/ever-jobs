# Tasks: 1723 — Server-side gate and cap for liveness probing

| Field        | Value      |
| ------------ | ---------- |
| Spec ID      | 1723       |
| Status       | done       |
| Last updated | 2026-09-24 |

- [x] T1 — `resolveLivenessConfig` + `configuration.ts` `liveness` section. Acceptance: config unit tests.
- [x] T2 — Controller gate: `EVER_JOBS_LIVENESS_ENABLED=false` → no probe, no field. Acceptance: controller test with a spy checker.
- [x] T3 — Controller cap: first N probed, rest untouched, warn on truncation. Acceptance: controller test with cap 2 over 5 jobs, JSON and NDJSON.
- [x] T4 — Docs: README "Liveness & legitimacy", `.env.example`, OpenAPI `liveness` description, Q-101.
