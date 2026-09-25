# Tasks — Spec 1736: Workday Company Sources

- [x] T1 — Look up tenant, cluster and site for the candidate employers.
- [x] T2 — Verify each board live (Spec 1735 probe; 2026-09-24).
- [x] T3 — Seed the 53 verified companies (naming, domains, tags, boards).
- [x] T4 — Scaffold the 53 plugins and wire them at the tail of the four shared files.
- [x] T5 — Generated suites green against the real Workday adapter; `tsc` clean.
- [x] T6 — Follow-up (Q-107, review 2026-09-25): pass the trimmed `searchTerm` to Workday's `searchText` in the adapter (`''` in list mode) so keyword searches stop enriching every posting of every tenant.
- [ ] T7 — Follow-up (Q-109): cover the listed non-Workday employers through their own ATS adapters (Oracle HCM for Dell, etc.).
- [x] T8 — Review follow-up (Spec 1735 §4.6): Workday detail enrichment sequential — 1 request in flight, 250–500 ms before each detail request; adapter suite asserts at most one in flight.
- [x] T9 — Review follow-up (Spec 1735 §4.2.1): keep a posting's Workday business-unit name; re-stamp only empty, tenant-token and legal-form names. **Superseded by T13.**
- [ ] T10 — Merge/deploy gate (§7): deploy only after the ever-hust full-result consumer is live, or ship with the batch listed in `EVER_JOBS_DISABLED_SOURCES` until it is.
- [x] T11 — Review follow-up F8 (spec §8): bound one Workday scrape — at most `WORKDAY_MAX_DETAIL_FETCHES` (default 50) detail requests, the rest returned at list level; `WORKDAY_SCRAPE_TIME_BUDGET_MS` (default 90 s, `0` = off) over listing and enrichment, a budget spent while listing reported as `partial`; list-level postings keep the enriched id (row requisition id) and link through the career site. Adapter suite red against the pre-T11 adapter first, then the change.
- [x] T12 — Review round 2, R3 (spec §8.1): an `additionalLocations` entry is a site only when it has a location shape (`hasWorkdayLocationShape`: the shared parser finds remote work, a state or a country, or a part is a US state or UK nation); a rejected entry (Moderna: "Drug Manufacturing") becomes the department when there is none. Shapeless entries are kept when the primary is itself shapeless. Tested with the recorded Moderna detail.
- [x] T13 — Review round 2, S2/R2 (spec §8.1): one identity per posting whether enriched or returned at list level. Company name: the adapter names every posting by its tenant (the detail-only `hiringOrganization` made a posting switch between a business unit and the display name as it crossed the detail cap) and the generator re-stamps the display name for Workday like every backend (re-scaffold of the 55 Workday plugins; each suite runs the real adapter with one detail request and a business-unit detail). Consumers are told to key Workday postings on `id`.
