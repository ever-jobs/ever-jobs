# Tasks: 1752 — ReliefWeb on API v2 (v1 is decommissioned)

| Field   | Value |
| ------- | ----- |
| Spec ID | 1752  |
| Status  | done (code); T6 open (owner) |

> Status legend: `[ ]` pending • `[~]` in-progress • `[x]` done • `[-]` dropped

- [x] T1 — Read the current v2 docs (home, parameters, fields tables). Acceptance: endpoint,
  appname rule (pre-approved since 2025-11-01), job fields `url` / `url_alias` / `body` /
  `body-html` recorded in spec.md §1–2.
- [x] T2 — Live checks within budget (≤3 API GETs, ≤2 site GETs, ≥1 s apart). Acceptance:
  v1 → 410 and v2 with `ever-jobs` → 403 bodies saved verbatim as fixtures; `/node/<id>`
  behaviour recorded (301 open, 410 closed). Used: 2 API + 2 site GETs.
- [x] T3 — Plugin on v2: endpoint, `RELIEFWEB_APPNAME` (trimmed, per scrape, default
  `ever-jobs`, start-up warning), appname-403 → `bad_input` with an actionable detail.
  Acceptance: `reliefweb.v2.spec.ts` request + error cases.
- [x] T4 — Links `url_alias` → `url` → `/node/<id>`, public-only; descriptions per format
  from `body` / `body-html`. Acceptance: `reliefweb.job-url.spec.ts` 4/4, `reliefweb.v2.spec.ts`
  mapping cases.
- [x] T5 — Docs: README ReliefWeb section, `.env.example`, `docs/index.md`, `docs/log.md`.
  Red control: 6 of 13 fail against the pre-change `src/`.
- [ ] T6 — (owner) Request a ReliefWeb appname and set `RELIEFWEB_APPNAME`; then run
  `reliefweb.e2e-spec.ts` once and compare a live v2 entry with `fixtures/reliefweb-v2-jobs.json`
  (especially the shape of `url`).
