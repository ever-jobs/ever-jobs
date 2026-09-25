# Plan: 5133 — ADP requisition-list pagination

| Field | Value |
| --- | --- |
| Spec ID | 5133 |
| Status | implemented |
| Created | 2026-09-17 |

## Phases

1. **`adpListUrl(host, cid, skip)`** — appends `&$skip=N&$top=20` for
   `skip > 0`; `ADP_PAGE_SIZE = 20` constant.
2. **`fetchAllPages`** — after host resolution answers the first page, loop
   `$skip += 20` collecting `jobRequisitions`; dedupe by `itemID`; stop when
   `jobs.length >= meta.totalNumber`, a page yields no fresh items, or a page
   fetch throws (warn + keep partial).
3. Tests + docs.

## Risks

- Mid-walk page failure returns a partial list — logged, and strictly better
  than page-1 truncation.
- `meta.totalNumber` trusted as the target; the empty/dup-page break covers a
  wrong total.
