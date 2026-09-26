# Spec: 5138 — Eightfold PCSX search endpoint fallback (`source-ats-eightfold`)

| Field | Value |
| --- | --- |
| Spec ID | 5138 |
| Slug | eightfold-pcsx-endpoint-fallback |
| Status | implemented |
| Owner | agent |
| Created | 2026-09-23 |

## Approach

Small, contained change in one file —
`packages/plugins/source-ats-eightfold/src/eightfold.service.ts` — plus
a new unit spec. No interface, type, or registration changes.

### Phases

1. **Payload unwrap helper.** `unwrapPositionsAndCount(body)` accepts
   either envelope: `{positions, count}` at top level (SmartApply) or
   `{data: {positions, count}}` (PCSX). Returns `null` for anything
   without a present `positions` array or numeric `count` — covers the
   `{message: "Not authorized for PCSX"}` gate and HTML responses
   (`typeof body !== 'object'`).
2. **Endpoint fallback in `fetchPage`.** Iterate the ordered endpoint
   list — remembered endpoint first, then `EIGHTFOLD_JOBS_PATH`, then
   `EIGHTFOLD_PCSX_SEARCH_PATH` — returning the first usable payload.
   Cache the winner on the instance (`private jobsPath`) so later pages
   skip the doomed request. Falls back once per run, not per page.
3. **Tests.** New `__tests__/eightfold.endpoints.spec.ts` mocking
   `createHttpClient` (same pattern as `nodi_global.service.spec.ts`):
   primary-works, gated→PCSX, HTML→PCSX, empty-valid no-fallback,
   resolved-endpoint reuse.

## Packages touched

- `packages/plugins/source-ats-eightfold/` — service + new spec file.

## Risks

- **False fallback on a legitimately empty board**: avoided by treating
  a present `positions` array (even empty) or numeric `count` (even 0)
  as a usable payload.
- **PCSX `error` envelope**: `{status:200, error:{message:"", body:""}, data:{...}}`
  — unwrapping only `data` ignores `error`; a non-empty `error.message`
  with empty positions still yields an empty page, consistent with the
  existing "empty page" path rather than an exception.
- **`host`/`domain` mismatch on gated tenants**: unchanged derivation
  keeps `companySlug` the authority for `domain=`; callers address
  custom-domain gated tenants with both inputs.
