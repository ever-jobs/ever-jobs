# Tasks — Spec 1735: ATS-Delegating Company-Source Pipeline

- [x] T1 — `probe-ats-delegate-company-source.ts`: serial, paced (>= 1.1 s), <= 3 requests per company, listing-only, honest UA; pure `buildProbeRequest`/`extractListings`/`countJobs`/`gateVariant`/`plannedVariants`; injectable transport + pacer.
- [x] T2 — Probe unit suite (no network).
- [x] T3 — Live verification runs 2026-09-24 (98 requests) merged into `scripts/seeds/ats-delegate-company-verification.json`.
- [x] T4 — `scaffold-ats-delegate-company-source.ts`: `BACKENDS` table (workday, greenhouse, lever, ashby, smartrecruiters, icims), `assembleDescriptors` refusing unverified boards, multi-board delegation, tags, fixtures, generated suites, `renderVerificationTable`.
- [x] T5 — Scaffold unit suite.
- [x] T6 — `wire-company-source-tail.ts` + unit suite (tail placement, idempotency, collision).
- [x] T7 — End to end: seed → scaffold → wire → generated suites green → `tsc` clean (Specs 1736, 1737).
- [ ] T8 — Follow-up (Q-108): replace the description tag suffix with a first-class metadata field once the crawl-policy change to `IPluginMetadata` has landed.
