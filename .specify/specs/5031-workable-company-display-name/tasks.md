# Tasks: 5031 — Workable company display name

- [x] T1 — Add `name?: string | null` to `WorkableResponse`.
    - Acceptance: types compile; the field is documented.
- [x] T2 — In `scrape` (public path), resolve
      `companyName = data.name?.trim() || companySlug` and pass it to
      `processJob`.
    - Acceptance: the widget `name` is read once per scrape; slug fallback when
      absent/blank.
- [x] T3 — Add a `companyName` parameter to `processJob` and use it for the
      `companyName` field; keep `companySlug` for the `jobUrl` fallback and other
      slug-derived fields.
    - Acceptance: `name` present → display name on every posting; absent → slug;
      `jobUrl`/`atsId` unchanged.
- [x] T4 — Add synthetic tests (display name from widget `name`, slug fallback);
      keep the existing public-path suites green.
    - Acceptance: the cases above are asserted; existing Workable suites green.
- [x] T5 — Run the `source-ats-workable` jest suite and typecheck the `apps/api`
      build; `lint:docs`.
    - Acceptance: suite green; `tsc --noEmit` clean on `apps/api`; docs lint clean.
