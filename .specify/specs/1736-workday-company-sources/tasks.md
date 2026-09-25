# Tasks — Spec 1736: Workday Company Sources

- [x] T1 — Look up tenant, cluster and site for the candidate employers.
- [x] T2 — Verify each board live (Spec 1735 probe; 2026-09-24).
- [x] T3 — Seed the 53 verified companies (naming, domains, tags, boards).
- [x] T4 — Scaffold the 53 plugins and wire them at the tail of the four shared files.
- [x] T5 — Generated suites green against the real Workday adapter; `tsc` clean.
- [x] T6 — Follow-up (Q-107, review 2026-09-25): pass the trimmed `searchTerm` to Workday's `searchText` in the adapter (`''` in list mode) so keyword searches stop enriching every posting of every tenant.
- [ ] T7 — Follow-up (Q-109): cover the listed non-Workday employers through their own ATS adapters (Oracle HCM for Dell, etc.).
- [x] T8 — Review follow-up (Spec 1735 §4.6): Workday detail enrichment sequential — 1 request in flight, 250–500 ms before each detail request; adapter suite asserts at most one in flight.
- [x] T9 — Review follow-up (Spec 1735 §4.2.1): keep a posting's Workday business-unit name; re-stamp only empty, tenant-token and legal-form names.
- [ ] T10 — Merge/deploy gate (§7): deploy only after the ever-hust full-result consumer is live, or ship with the batch listed in `EVER_JOBS_DISABLED_SOURCES` until it is.
