# Spec: 5138 — Eightfold PCSX search endpoint fallback (`source-ats-eightfold`)

| Field | Value |
| --- | --- |
| Spec ID | 5138 |
| Slug | eightfold-pcsx-endpoint-fallback |
| Status | implemented |
| Owner | agent |
| Created | 2026-09-23 |

## Problem

Some Eightfold tenants disable anonymous access to the SmartApply
positions endpoint `/api/apply/v2/jobs`. The request returns
`{"message": "Not authorized for PCSX"}` (JSON, HTTP 200) or, when the
`domain` parameter is wrong for the tenant, the SPA HTML shell — either
way the scraper sees no `positions`/`count` payload and yields zero jobs
for a board that has hundreds.

The same tenants leave the documented PCSX search endpoint
`/api/pcsx/search` open anonymously. It accepts the same pagination
parameters and returns the same position records, wrapped in a
`{status, error, data: {positions, count}}` envelope.

Observed live on `careers.gf.com` (tenant domain `globalfoundries.com`,
declared in the page's `pcsxConfig`): `apply/v2/jobs` → "Not authorized
for PCSX"; `pcsx/search?domain=globalfoundries.com` → 525 positions, no
cookies or session bootstrap required.

## Contract

- `fetchPage` tries `EIGHTFOLD_JOBS_PATH` first (unchanged for tenants
  where SmartApply is open). When the response body is not a usable
  positions payload — HTML string, `{message: ...}`, or any object
  lacking `positions`/`count` — it falls back to
  `EIGHTFOLD_PCSX_SEARCH_PATH` with the same query params and unwraps
  the `data` envelope.
- The resolved endpoint is remembered for the run so subsequent pages
  hit the working endpoint directly instead of paying a doomed request
  per page.
- Payload detection treats a present-but-empty `positions` array or a
  `count` of `0` as a valid response (no fallback) — a legitimately
  empty board must not be re-queried on the other endpoint.
- Domain derivation is unchanged: `companySlug` → `{slug}.com`,
  otherwise the `companyUrl` hostname. Gated tenants whose custom
  careers host differs from the tenant domain are addressed with both
  (`companySlug` supplies `domain=`, `companyUrl` supplies the host).
- All other mapping (title, atsId, locations, remote, dates,
  department, employmentType, urls) is unchanged — PCSX positions carry
  the same field names already modelled in `eightfold.types.ts`.

## Non-goals

- No session/cookie/CSRF bootstrap — the open endpoint needs none.
- No per-tenant config table; fallback is automatic and stateless.
- No changes to host/domain resolution logic.

## Test plan

- Unit: primary endpoint returns a valid payload → no fallback call.
- Unit: primary returns `{"message": "Not authorized for PCSX"}` →
  PCSX endpoint is called, positions+count unwrapped from `data`.
- Unit: primary returns an HTML string → same fallback behaviour.
- Unit: empty-but-valid `{positions: [], count: 0}` → no fallback.
- Unit: once resolved, later pages call the PCSX endpoint directly.
- Existing location/mapping specs stay green unchanged.
