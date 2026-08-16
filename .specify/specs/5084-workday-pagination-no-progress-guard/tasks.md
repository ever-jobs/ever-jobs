# Tasks: 5084 — Workday pagination never stops when a tenant re-serves page 1

- [x] T1 — Pagination: `workdayListingKey`; accumulate distinct listings only; break when a page adds zero new; stop when a positive `total` is reached; `resultsWanted` bounds distinct postings. Acceptance: a tenant that returns page 1 for every offset yields exactly its distinct postings in 2 list requests.
- [x] T2 — Enrichment: de-dupe before `fetchDetails`; skip enrichment when pagination failed; log an `N of M detail requests failed` summary. Acceptance: no detail request is issued twice for one posting, and a pagination failure issues none.
- [x] T3 — Tests: wrapping tenant (with and without a usable `total`), honest 24-job tenant, a real page reporting `total: 0`, `resultsWanted` below board size, throwing pagination. Acceptance: touched suites green.
- [x] T4 — Docs: `docs/index.md` row, `docs/log.md` entry (newest at top); `tsc --noEmit` and `lint:docs` clean.
