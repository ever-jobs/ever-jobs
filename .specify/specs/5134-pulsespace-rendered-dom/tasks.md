# Tasks: 5134 — PulseSpace rendered-DOM scrape

- [x] T1 — Replace bundle parsing with `BrowserPool` render of `/careers` +
      `/careers/<slug>` detail pages.
    - Acceptance: rendered list yields role URLs; detail page yields title,
      location, job type, department, and a sectioned description.
- [x] T2 — New rendered-HTML fixtures + spec rewrite (list link extraction,
      badge fields, description sections, filters, empty-list case).
    - Acceptance: `jest source-company-pulsespace` green.
- [x] T3 — Docs + live validation.
    - Acceptance: live scrape returns the 1 live role with full fields.
