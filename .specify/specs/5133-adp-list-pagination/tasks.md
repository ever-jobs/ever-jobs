# Tasks: 5133 — ADP requisition-list pagination

- [x] T1 — `adpListUrl(host, cid, skip)` + `ADP_PAGE_SIZE`; `fetchAllPages`
      walks `$skip`/`$top` pages until `meta.totalNumber`, empty/dup page, or
      fetch error.
    - Acceptance: a 45-req board over 3 pages yields 45 jobs; page-2 failure
      keeps page 1; empty page stops the walk.
- [x] T2 — unit tests + docs (`docs/index.md`, `docs/log.md`).
    - Acceptance: `jest source-ats-adp` green; live tenant returns all 160
      requisitions with unique ids.
