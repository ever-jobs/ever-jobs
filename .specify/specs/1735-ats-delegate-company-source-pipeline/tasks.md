# Tasks — Spec 1735: ATS-Delegating Company-Source Pipeline

- [x] T1 — `probe-ats-delegate-company-source.ts`: serial, paced (>= 1.1 s), <= 3 requests per company, listing-only, honest UA; pure `buildProbeRequest`/`extractListings`/`countJobs`/`gateVariant`/`plannedVariants`; injectable transport + pacer.
- [x] T2 — Probe unit suite (no network).
- [x] T3 — Live verification runs 2026-09-24 (98 requests) merged into `scripts/seeds/ats-delegate-company-verification.json`.
- [x] T4 — `scaffold-ats-delegate-company-source.ts`: `BACKENDS` table (workday, greenhouse, lever, ashby, smartrecruiters, icims), `assembleDescriptors` refusing unverified boards, multi-board delegation, tags, fixtures, generated suites, `renderVerificationTable`.
- [x] T5 — Scaffold unit suite.
- [x] T6 — `wire-company-source-tail.ts` + unit suite (tail placement, idempotency, collision).
- [x] T7 — End to end: seed → scaffold → wire → generated suites green → `tsc` clean (Specs 1736, 1737).
- [ ] T8 — Follow-up (Q-108): replace the description tag suffix with a first-class metadata field once the crawl-policy change to `IPluginMetadata` has landed.
- [x] T9 — Review follow-up (§4.5): generated plugins delegate with `auth: undefined`; `source-ats-greenhouse` scopes the env Harvest key to `GREENHOUSE_HARVEST_BOARD`; generated Greenhouse suites prove only the public board is requested with `GREENHOUSE_API_KEY` set.
- [x] T10 — Review follow-up (§4.2.1): Workday plugins keep a posting's business-unit name and re-stamp only empty / tenant / legal-form names. **Superseded by Spec 1736 T13** (the name exists in the detail response only, so past the detail cap a posting switched names): Workday plugins re-stamp the display name like every backend.
- [x] T11 — Review follow-up (§3.1, §4.7): robots.txt and terms review of the five host families; SIG made explicit-only (its iCIMS host disallows all crawlers).
- [ ] T12 — Follow-up for the crawl-policy lane (Spec 1690): per-host limits for the shared Workday clusters, Lever's `Crawl-delay: 1`, and whether the adapters keep a desktop-Chrome User-Agent (§3.1).
