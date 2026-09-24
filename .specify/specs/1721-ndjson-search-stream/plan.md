# Plan: 1721 — NDJSON search stream, configurable fan-out deadline, per-job dedup key

| Field        | Value      |
| ------------ | ---------- |
| Spec ID      | 1721       |
| Status       | done       |
| Last updated | 2026-09-24 |

## Approach

1. **`dedupKeyForJob`** in `packages/common/src/canonical-key.ts`, plus `formatJobLocation`
   (the flat rendering the dedup engine already used privately). `dedup-hybrid` switches to the
   shared `formatJobLocation` so the engine and the API can never disagree on a key.
2. **Aggregator** stamps `dedupKey` on its output list on every exit path.
3. **`NdjsonWriter`** (`apps/api/src/jobs/ndjson-writer.ts`): wraps a `PassThrough`; `write(obj)`
   serialises one line and awaits `drain` when needed; `close()`; tracks `closed` when the
   response closes so a disconnected client stops the producer.
4. **Controller**: `format=ndjson` branch set up before any work: headers, writer, heartbeat
   (`setInterval`, 10 s, `unref`), detached producer that reuses the same cache → fan-out →
   aggregate → liveness → legitimacy steps as JSON, then streams the job lines and `end`. The
   shared steps are factored into one private method so JSON and NDJSON cannot drift.
5. **Service** reports progress via the `onProgress` option added in Spec 1720.
6. **Config**: `resolveFanoutDeadlineMs(env)` in `apps/api/src/config/search-config.ts`, used by
   `configuration.ts`; the service's deadline log names the new variable.
7. **GraphQL / CSV**: `dedupKey` field; CSV flattener joins nested arrays.

## Files

| File | Change |
| ---- | ------ |
| `packages/common/src/canonical-key.ts` | `formatJobLocation`, `dedupKeyForJob` |
| `packages/plugins/dedup-hybrid/src/dedup-hybrid.service.ts` | use shared `formatJobLocation` |
| `packages/models/src/dtos/job-post.dto.ts` | `dedupKey` |
| `apps/api/src/jobs/jobs.aggregator.ts` | stamp keys |
| `apps/api/src/jobs/ndjson-writer.ts` | new |
| `apps/api/src/jobs/jobs.controller.ts` | NDJSON branch, shared pipeline, CSV nested arrays, OpenAPI |
| `apps/api/src/jobs/gql-types.ts` | `dedupKey` |
| `apps/api/src/config/search-config.ts`, `configuration.ts` | deadline alias |

## Risks

- **Proxy buffering** (nginx ingress) would hold lines back — mitigated by
  `X-Accel-Buffering: no`; documented.
- **Unhandled rejection in the detached producer** — the producer body is one `try/catch`
  that converts everything to an `error` line and always clears the heartbeat.

## Verification

Controller NDJSON suite, aggregator suite, common canonical-key suite, config suite; `tsc`.
