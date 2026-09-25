# Tasks: 5135 — Source ATS plugin: Nodi (`source-ats-nodi_global`)

- [x] T1 — Plugin package: service hits `job-offers/active/company/<slug>`
      for the offer list and `companies/by-name` for company metadata; maps
      each offer (title, location, department, type, modality, salary,
      `created_at`, HTML description, `magic_link`) to `JobPostDto`.
    - Acceptance: a mocked 8-offer fixture yields 8 `JobPostDto`s with all
      fields populated.
- [x] T2 — Register `Site.NODI_GLOBAL`, `ALL_SOURCE_MODULES`, tsconfig path,
      jest moduleNameMapper; spec + fixture tests.
    - Acceptance: `jest source-ats-nodi_global` green (9 tests).
- [x] T3 — Docs (`docs/index.md`, `docs/log.md`) + live validation.
    - Acceptance: live `radical ai` scrape returns 8 jobs.
