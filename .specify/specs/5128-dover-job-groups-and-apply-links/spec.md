# Spec: 5128 — Dover job-groups (department) and per-job apply links

| Field | Value |
| --- | --- |
| Spec ID | 5128 |
| Slug | dover-job-groups-and-apply-links |
| Status | implemented |
| Owner | agent |
| Created | 2026-09-16 |
| Related specs | 5033 |

## Problem

Two gaps in the Dover adapter (Spec 5033), verified against a live Dover board
carrying 33 open roles in 11 job groups:

- **Department is never emitted.** Dover groups each tenant's roles into named
  job groups (e.g. `Design`, `Hardware`, `Machine Learning`) — visible on the
  `app.dover.com/jobs/{slug}` board — but neither the flat jobs list
  (`careers-page/{id}/jobs`) nor the detail overlay
  (`inbound/application-portal-job/{id}`) carries the group. The board SPA
  sources it from a third endpoint the adapter never calls, so
  `JobPostDto.department` stays unset for every Dover role.
- **`jobUrl` / `applyUrl` are the board URL for every role.** The adapter emits
  `https://app.dover.com/jobs/{slug}` (the tenant's whole board) on all jobs,
  not a per-role link. Dover's real per-role URL is the apply form,
  `https://app.dover.com/apply/{slug}/{jobId}` — the same target the board links
  each role to.

## Scope

In `packages/plugins/source-ats-dover`:

- **Job groups → `department`.** After resolving the careers-page client id,
  `GET /api/v1/job-groups/{clientId}/job-groups` →
  `[{ id, name, jobs: [{ id, ... }] }]`. Build a `jobId → group name` map and set
  `JobPostDto.department` to the role's group name; roles absent from every
  group (or a failed/empty job-groups call) keep `department` unset — listing
  and detail enrichment are unaffected.
- **Per-role apply links.** `jobUrl` and `applyUrl` become
  `https://app.dover.com/apply/{slug}/{jobId}` when the careers page resolves a
  slug; tenants resolvable only by careers-page UUID with no slug keep the
  existing `/careers/{clientId}` fallback.
- Types/constants: a `DoverJobGroup` shape, the job-groups URL template, and
  the apply-URL template.

## Non-goals

- No change to the jobs list or detail-overlay calls, token/slug resolution, or
  `JobPostDto` shape.
- The flat `careers-page/{id}/jobs` list stays the role source of truth (a role
  could exist outside all groups); job-groups only contributes names.
- No new `@ever-jobs/common` helper.

## Contracts

- A resolved tenant emits each role's `jobUrl`/`applyUrl` as
  `https://app.dover.com/apply/{slug}/{jobId}`.
- `department` is the role's job-group `name` when the role id appears in the
  job-groups feed; otherwise unset.
- A failed or malformed job-groups response degrades to `department` unset —
  never throws, never drops roles.
- A tenant with no resolvable slug (UUID-only careers page) keeps
  `https://app.dover.com/careers/{clientId}` urls.

## Test plan

- **Dover unit (mocked HTTP)** — `dover.service.spec.ts`:
  - job-groups feed present → `department` is the group's `name` for mapped
    roles, unset for unmapped;
  - `jobUrl`/`applyUrl` are `https://app.dover.com/apply/{slug}/{jobId}`;
  - job-groups 4xx / missing → roles still emit with `department` unset;
  - UUID-resolved page with a slug → apply links still use the slug;
  - careers page with no slug → `/careers/{clientId}` urls (unchanged fallback).
