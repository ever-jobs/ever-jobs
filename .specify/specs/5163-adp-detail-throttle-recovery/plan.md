# Plan 5163

| Field | Value |
| ----- | ----- |
| Spec | `.specify/specs/5163-adp-detail-throttle-recovery/spec.md` |
| Package | `packages/plugins/source-ats-adp` |

## Phases

1. **Constants** (`adp.constants.ts`): `ADP_DETAIL_CONCURRENCY` 5 → 4; add
   `ADP_DETAIL_RETRY_COOLDOWN_MS = 30_000`, `ADP_DETAIL_RETRY_GAP_MS = 300`,
   `ADP_DETAIL_RETRY_ROUNDS = 2`.
2. **Service** (`adp.service.ts`):
   - `scrape()` builds a second client for detail calls:
     `detailClient = createHttpClient({ proxies, caCert, timeout, retries: 0 })`
     with `ADP_HEADERS`.
   - `fetchDetails(detailClient, host, cid, jobs)` records rejected indices in
     a `failed` set (fulfilled-null is *not* failed), then runs the serial
     recovery loop (cooldown → sequential fetches with gap → repeat ≤ 2 rounds)
     and emits warn summaries.
   - Import `sleep` from `@ever-jobs/common`.
3. **Tests** (`__tests__/adp.service.spec.ts`): mock `sleep` in the
   `@ever-jobs/common` mock; cover recovery-success, recovery-exhausted,
   no-failure (no cooldown), and `retries: 0` client construction.
4. **Docs**: `docs/index.md` spec-table row + `docs/log.md` entry.

## Risks

- Recovery lengthens wall time on throttled boards (~1–2 min worst case) —
  bounded by `ADP_DETAIL_RETRY_ROUNDS`.
- `fetchDetail` callers: only `fetchDetails` — the signature change is local.
