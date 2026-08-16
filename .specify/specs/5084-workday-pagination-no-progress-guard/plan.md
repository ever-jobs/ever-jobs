# Plan: 5084 — Workday pagination never stops when a tenant re-serves page 1

| Field        | Value        |
| ------------ | ------------ |
| Spec         | spec.md      |
| Created      | 2026-06-28   |
| Last updated | 2026-06-28   |

## Phases

1. **Pagination.** `workdayListingKey` helper; distinct-progress accumulation; no-progress break;
   positive-`total` fast path; `resultsWanted` bounds distinct postings.
2. **Enrichment.** De-dupe before `fetchDetails`; skip enrichment entirely after a pagination failure;
   per-scrape detail-failure summary.
3. **Tests + docs.** Suite cases for wrapping / honest / `total: 0` / throwing tenants;
   `docs/index.md`, `docs/log.md`.

## Packages touched

- `packages/plugins/source-ats-workday`

## Risks

- **Over-eager stop truncating a real board.** Mitigated: the guard stops only when a page adds *zero*
  new postings, and the `total` fast path ignores a zero/absent `total` (the wrapping tenant's genuine
  second page reports `total: 0`). Covered by the 24-job honest-tenant test.
- **De-dup key wrong for some tenant.** `externalPath` is the detail-URL path, unique per requisition;
  pathless listings fall back to `title` so nothing is dropped silently.
- **Skipping enrichment on failure loses partial results.** Intentional: those listings are exactly the
  ones that funded the 429 storm, and the response already reports diagnostics instead.
