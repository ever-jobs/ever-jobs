# Tasks — Spec 1736: Workday Company Sources

- [x] T1 — Look up tenant, cluster and site for the candidate employers.
- [x] T2 — Verify each board live (Spec 1735 probe; 2026-09-24).
- [x] T3 — Seed the 53 verified companies (naming, domains, tags, boards).
- [x] T4 — Scaffold the 53 plugins and wire them at the tail of the four shared files.
- [x] T5 — Generated suites green against the real Workday adapter; `tsc` clean.
- [ ] T6 — Follow-up (Q-107): pass `searchTerm` to Workday's `searchText` in the adapter so keyword searches stop enriching every posting of every tenant.
- [ ] T7 — Follow-up (Q-109): cover the listed non-Workday employers through their own ATS adapters (Oracle HCM for Dell, etc.).
