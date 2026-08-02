# Spec: 5031 — Workable company display name

| Field | Value |
| --- | --- |
| Spec ID | 5031 |
| Slug | workable-company-display-name |
| Status | implemented |
| Owner | agent |
| Created | 2026-06-28 |
| Last updated | 2026-06-28 |
| Related specs | 5014, 5030 |

## Problem

The Workable plugin's public path ships the **slug** as `companyName`, not the
company's display name. `processJob` sets `companyName: companySlug` (e.g.
`shift-robotics`), even though the public widget list response carries the
human-readable display name at its top-level `name` field (`Shift Robotics`).
The `WorkableResponse` type does not model `name`, so the slug is shipped on
every posting.

This is the same class of bug fixed for BreezyHR in Spec 5030. It is silent
whenever the display name is a single token equal to the slug (e.g. `Elastium`
→ `elastium`), and surfaces wherever they differ (`Shift Robotics` →
`shift-robotics`).

## Scope

- **Company display name (public path).** Read the widget response's top-level
  `name`; fall back to the slug only when it is absent/blank. Add `name` to
  `WorkableResponse`. Pass the resolved display name into `processJob`.

## Non-goals

- No change to the list/detail endpoints, the bounded-concurrency detail
  overlay, or the fail-safe behaviour.
- No change to location / `isRemote` / date / description / compensation /
  `jobType` / `workFromHomeType` mapping.
- **Authenticated API v3 path unchanged.** The v3 jobs response
  (`WorkableApiV3Response`) carries no account/company name, so `processApiJob`
  keeps the slug as the only available value (the ADP/bamboohr situation). The
  bug and fix are specific to the public widget path that all checked STATUS
  companies use (no `WORKABLE_API_TOKEN` set).
- No plugin imports another plugin.

## Contracts

- `JobPostDto` shape unchanged.
- A widget response with `name: "Shift Robotics"` yields
  `companyName: "Shift Robotics"` on every posting.
- A widget response with no `name` (or blank) falls back to the slug
  (behaviour-preserving for that case).
- `jobUrl` / `atsId` / other slug-derived fields are unchanged (they still use
  the slug, not the display name).

## Test plan

- **Workable service (public path)**, new cases:
    - display name: widget `name` → `companyName` (display name, not slug).
    - slug fallback: widget response with no `name` → `companyName` is the slug.
- Existing Workable suites stay green (detail overlay/description, jobFunction,
  workFromHomeType, isRemote, compensation text-parse, fail-safe, no-slug).

## Risks

- None material. The change only replaces the slug with the display name when
  one is present; it never removes data and never affects slug-derived fields.
