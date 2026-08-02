# Tasks: 5026 — Ashby `isRemote` reads structured `workplaceType`

- [x] T1 — Add `workplaceType?: string | null` to `AshbyJob` in `ashby.types.ts`.
    - Acceptance: the field is modelled; package typecheck clean.
- [x] T2 — In `ashby.service.ts`, derive `isRemote` from `workplaceType` (Remote
      only) with the boolean `isRemote` as fallback, OR'd with location-text
      `remoteMentioned`; map `workplaceType` → `workFromHomeType` merged with the
      location-text value.
    - Acceptance: Hybrid (`isRemote=true`, `workplaceType='Hybrid'`) → `isRemote:
      false`, `workFromHomeType: 'Hybrid'`; Remote → `isRemote: true`,
      `workFromHomeType: 'Remote'`; no `workplaceType` → boolean fallback.
- [x] T3 — Add ashby service tests for Hybrid / Remote / no-workplaceType.
    - Acceptance: the three cases above are asserted; existing suites green.
- [x] T4 — Run the ashby suites and typecheck the package.
    - Acceptance: `source-ats-ashby` jest suites green; `tsc --noEmit` clean.
