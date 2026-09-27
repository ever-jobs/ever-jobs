# Spec: 1723 — Server-side gate and cap for liveness probing

| Field          | Value                                    |
| -------------- | ---------------------------------------- |
| Spec ID        | 1723                                     |
| Slug           | liveness-server-gate                     |
| Status         | done                                     |
| Owner          | agent                                    |
| Created        | 2026-09-24                               |
| Last updated   | 2026-09-24                               |
| Supersedes     | (none)                                   |
| Related specs  | 721, 740, 5025, 1721                     |

## 1. Problem Statement

`?liveness=true` (Spec 740) makes the API issue one outbound GET per returned job through the
`liveness-http` plugin (Spec 721). It is opt-in per request, which is right — but:

- the operator has **no server-side switch**. Anyone who can reach the API can make it probe
  every job URL of an unpaginated, catalogue-wide search (20–30 k requests at concurrency 5);
- there is **no cap**. Spec 5025 scoped probing to the returned page, which bounds paginated
  requests (`page_size ≤ 100`), but an unpaginated JSON or NDJSON (Spec 1721) search returns
  the whole corpus.

The owner's direction: liveness must be *possible* per request, configured in Ever Jobs, and
**disabled by default** so nothing probes unless asked.

## 2. Goals

- Keep liveness a per-request opt-in (absent = off).
- An operator switch that can refuse probing even when requested.
- A per-request cap on probed URLs.

## 3. Non-Goals

- Changing the liveness heuristics or the plugin's concurrency (Spec 721).
- Caching verdicts across requests.

## 4. Functional Requirements

| ID    | Requirement | Priority |
| ----- | ----------- | -------- |
| FR-1  | `?liveness=true\|1\|yes` requests probing; absent or anything else → no probing (unchanged). | must |
| FR-2  | `EVER_JOBS_LIVENESS_ENABLED` (default `true` = honour the request flag). `false/0/no/off` → never probe; the response carries **no** `liveness` field even when requested (and a debug log records the refusal). | must |
| FR-3  | `EVER_JOBS_LIVENESS_MAX_URLS` caps probes per request. Default **100** (the existing `page_size` ceiling, so every paginated request behaves exactly as before). The first N jobs in output order are probed; the rest carry no `liveness`. `0` or negative → no cap; non-numeric → default. | must |
| FR-4  | Applies identically to JSON, CSV and NDJSON (Spec 1721). | must |
| FR-5  | Legitimacy is unchanged: still per-request opt-in, still folds in liveness when present. A legitimacy gate is optional in the contract and deliberately not added (it is in-process and makes no network calls). | should |
| FR-6  | When the cap truncates, a `warn` log records `probed N of M`. | should |

## 5. Contracts

```ts
// apps/api/src/config/search-config.ts
export const DEFAULT_LIVENESS_MAX_URLS = 100;
export function resolveLivenessConfig(env): { enabled: boolean; maxUrls: number /* 0 = no cap */ };
// configuration.ts → liveness: { enabled, maxUrls }
```

## 6. Test Plan

- Config: default `{ enabled: true, maxUrls: 100 }`; `false`/`0`/`off` disable; junk → default;
  `0` → no cap.
- Controller: gate off + `?liveness=true` → checker never called, no `liveness` on any job;
  gate on + flag absent → not called; cap 2 with 5 jobs → exactly 2 URLs probed, the other 3
  have no `liveness`; NDJSON path honours the cap.

## 7. Open Questions

- Q-101 — default cap value and what an unprobed job carries. Default: 100; field absent.

## 8. Decisions

- D-01 — Unprobed jobs carry no `liveness` rather than `uncertain`: "we did not look" and "we
  looked and could not tell" are different facts.
- D-02 — The gate is read per request from `ConfigService`, so tests and future hot-reload need
  no restart semantics.

## 9. References

- `apps/api/src/jobs/jobs.controller.ts` (`enrichLiveness`)
- `packages/plugins/liveness-http`
