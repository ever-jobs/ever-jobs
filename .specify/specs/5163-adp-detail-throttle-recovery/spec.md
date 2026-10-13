# Spec 5163

| Field | Value |
| ----- | ----- |
| Title | ADP detail-fetch throttle recovery |
| Status | Proposed |
| Package | `packages/plugins/source-ats-adp` |

## Problem

The ADP list feed omits the posting body — `requisitionDescription` lives only
on the per-requisition detail endpoint, so the plugin issues one detail GET per
listing under bounded concurrency. ADP rate-limits that endpoint to roughly
~190–200 requests per rolling window: on a large board the tail of the batched
fan-out is rejected with HTTP 429, and `Promise.allSettled` swallows each
rejection into `details[i] = null` with no log. Those jobs still emit — with an
empty `description` — and on one observed 235-job board ~16% of rows lost their
descriptions this way, on consecutive runs.

The shared HTTP client also retries every 429 up to 3 times with backoff, so a
tripped limiter receives ~4× the failing tail — extending the block it caused.

## Proposal

Make detail fetches fail fast, then recover the failed tail serially after a
cooldown:

- **Concurrency** drops from `ADP_DETAIL_CONCURRENCY = 5` to **4**.
- **Fail-fast detail client**: `fetchDetail` uses a dedicated
  `createHttpClient({ retries: 0 })` — no in-client retries during the bulk
  pass. The list client keeps the default retry behavior.
- **Recovery pass**: after the batched pass, indices whose detail request
  *rejected* are retried serially — `ADP_DETAIL_RETRY_COOLDOWN_MS` (30 s)
  cooldown, then one request at a time with a small per-request gap
  (`ADP_DETAIL_RETRY_GAP_MS`, 300 ms), for up to `ADP_DETAIL_RETRY_ROUNDS` (2)
  rounds. A fulfilled-but-null detail (API answered with no payload) is not
  retried — rejection is the throttle signal.
- **Logging**: `logger.warn` reports `N of M detail fetches failed` after the
  bulk pass and the final still-missing count after recovery.

## Contracts

- Behavior change is internal to `AdpService`; `JobResponseDto` shape is
  unchanged. Jobs whose details never recover still emit (list fields only,
  `description: null`) — fail-safe semantics preserved.
- New constants in `adp.constants.ts`: `ADP_DETAIL_RETRY_COOLDOWN_MS`,
  `ADP_DETAIL_RETRY_GAP_MS`, `ADP_DETAIL_RETRY_ROUNDS`.
- Wall-time bound: worst case adds ~(rounds × cooldown) + ~0.5 s/failed item;
  only paid when throttled.

## Test plan

- Bulk-pass detail rejection followed by recovery success → description
  populated on the emitted job.
- Persistent detail rejection → job still emits with `description: null`;
  warn logged; exactly `ADP_DETAIL_RETRY_ROUNDS` recovery rounds attempted.
- No failures → no recovery sleep/extra calls (mocked `sleep` asserts zero
  cooldowns).
- `createHttpClient` invoked with `retries: 0` for the detail client.
