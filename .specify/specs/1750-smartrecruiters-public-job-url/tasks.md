# Tasks: 1750 — a SmartRecruiters job links to its posting page, not to the API

| Field   | Value |
| ------- | ----- |
| Spec ID | 1750  |
| Status  | done  |

> Status legend: `[ ]` pending • `[~]` in-progress • `[x]` done • `[-]` dropped

- [x] T1 — Confirm the live wire shape (at most 3 GETs). Acceptance: list `ref` is the API
  resource and carries no `postingUrl`/`applyUrl`/`jobAd`; detail carries `postingUrl` +
  `applyUrl`; `https://jobs.smartrecruiters.com/AbbVie/<id>` returns 200 HTML.
- [x] T2 — `jobUrl` = `postingUrl` or the public pattern from the API's company identifier;
  `applyUrl` from the API's `applyUrl`; `ref` parsed only for id/identifier fallbacks.
  Acceptance: `smartrecruiters.service.spec.ts` 10/10.
- [x] T3 — `id`, `atsId` and the URL use one posting id; a posting with no id is skipped.
  Acceptance: covered by T2's suite (id-from-ref and no-id cases).
- [x] T4 — Delegating plugins: 217 fixtures (651 `ref`s) rewritten to the API form, 217
  assertions to the public pattern + `not.toContain('api.smartrecruiters.com')`; scaffold
  template updated. Acceptance: all 217 suites green.
- [x] T5 — Red control. Acceptance: `job.ref ??` reintroduced → plugin suite, AbbVie suite
  and the Spec 1751 guard fail; restored → green.
- [x] T6 — Docs: spec/plan/tasks, `docs/index.md` row, `docs/log.md` entry, **Q-111**
  (list endpoint has no description; detail fetch or not).
