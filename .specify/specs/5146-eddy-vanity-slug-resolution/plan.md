# Plan: 5146 — Eddy vanity-slug tenant resolution

| Field          | Value                              |
| -------------- | ---------------------------------- |
| Spec ID        | 5146                               |
| Slug           | eddy-vanity-slug-resolution        |
| Status         | done                               |
| Owner          | agent                              |
| Created        | 2026-09-23                         |
| Last updated   | 2026-09-23                         |

## 1. Approach

`source-ats-eddy` currently returns an empty board whenever the tenant identifier isn't
an organization UUID — but Eddy's own careers SPA resolves vanity short names through a
public anonymous lookup before calling the UUID-keyed jobs endpoints. Mirror that:

1. **Constant** — add `eddyOrganizationIdUrl(slug)` =
   `${EDDY_API_ORIGIN}/api/ds/organization/{slug}/id` and the
   `EddyOrganizationIdResponse` type (`{currentShortName, organizationUuid}`).
2. **Resolution order in `scrape()`** — build the HTTP client first (it already caps
   the timeout), then resolve the tenant:
   - existing UUID paths (`companySlug` UUID, `companyUrl` UUID segment) — unchanged,
     **zero extra requests**;
   - otherwise collect the slug candidate (bare `companySlug`, or the first non-UUID
     `/careers/{…}` segment of an Eddy-host `companyUrl`) and issue one
     `GET /api/ds/organization/{slug}/id`; a UUID-shaped `organizationUuid` wins,
     anything else → empty.
3. **Slug lookup helper** — `resolveSlugToUuid(client, slug)`: never throws; returns `''`
   on HTTP error, non-object body, or non-UUID `organizationUuid`. Tries the slug
   as-given, then lowercased.
4. Everything downstream (`fetchJobsList`, `fetchDetails`, `eddyJobPageUrl`,
   `deriveSlugName`) keeps operating on the resolved UUID — no signature changes.

## 2. Packages touched

- `packages/plugins/source-ats-eddy/src/eddy.constants.ts` — new URL builder + reserved
  note.
- `packages/plugins/source-ats-eddy/src/eddy.types.ts` — `EddyOrganizationIdResponse`.
- `packages/plugins/source-ats-eddy/src/eddy.service.ts` — client-before-resolution
  ordering, slug candidate extraction, `resolveSlugToUuid`.
- `packages/plugins/source-ats-eddy/__tests__/eddy.slug-resolution.spec.ts` — new
  mocked unit spec.

## 3. Risks

- **Slug-lookup availability**: the endpoint is the same public surface the careers SPA
  uses; a 404/error degrades to empty (same as unknown UUID today).
- **Route constants as slugs**: for `/careers/{slug}/preview/embed` the slug is always
  the *first* post-`careers` segment, so `preview`/`embed`/`apply` never become
  candidates. A URL that is literally `/careers/preview` would attempt a lookup and
  404 → empty — acceptable.
- **Latency**: one extra GET only when input lacks a UUID; bounded by the capped
  client timeout.

## 4. Validation

- `npx jest source-ats-eddy` — new mocked spec + existing e2e suite.
- `npx tsc --project tsconfig.typecheck.json --noEmit`.
- `npm run lint:docs`.
- Live smoke during implementation: `hypercraftusa` → UUID → 3 roles.
