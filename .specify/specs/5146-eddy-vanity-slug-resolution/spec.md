# Spec: 5146 — Eddy vanity-slug tenant resolution

| Field          | Value                              |
| -------------- | ---------------------------------- |
| Spec ID        | 5146                               |
| Slug           | eddy-vanity-slug-resolution        |
| Status         | done                               |
| Owner          | agent                              |
| Created        | 2026-09-23                         |
| Last updated   | 2026-09-23                         |
| Supersedes     | (none)                             |
| Related specs  | 396                                |

## 1. Problem Statement

`source-ats-eddy` addresses a tenant solely by its **organization UUID**: `companySlug`
must be a UUID (or a careers URL containing one), and the anonymous jobs API
(`/api/ats/public/job-opening/organization/{uuid}`) rejects vanity slugs with
`400 Failed to convert 'organizationUuid'`. Real-world Eddy careers links, however, are
commonly issued with the tenant's **vanity short name** —
`https://app.eddy.com/careers/hypercraftusa/preview/embed` — which contains no UUID at
all. Today such input resolves to nothing and the scrape silently returns an empty board
even though the tenant's roles are publicly reachable.

## 2. Goals

- Accept a vanity short name anywhere a tenant identifier is accepted: bare
  `companySlug` (`hypercraftusa`) and any `companyUrl` on the Eddy careers host whose
  first `/careers/{…}` segment is non-UUID (`/careers/{slug}`, `/careers/{slug}/preview/embed`,
  `/careers/{slug}/{jobUuid}/apply`, …).
- Resolve the slug via Eddy's own public, anonymous lookup
  `GET /api/ds/organization/{slug}/id` → `{organizationUuid}` (verified live:
  `hypercraftusa` → `d7e3b662-b7f9-458c-8a91-34374094c69f`, whose open-roles list
  returns 3 jobs anonymously).
- Preserve all existing behavior for UUID inputs — the lookup only runs when no UUID
  was found.
- Degrade gracefully: an unknown or unresolvable slug still yields an empty result,
  never a thrown error that nukes a batch.

## 3. Non-Goals

- No change to the jobs list/detail endpoints, mapping, or output shape.
- No slug→UUID caching layer (one extra GET per scrape is trivial).
- No support for non-`app.eddy.com` vanity hosts (none are known to exist).
- No authenticated endpoints (the `…/preview` admin extras remain out of scope).

## 4. Contracts

- **New endpoint constant**: `eddyOrganizationIdUrl(slug)` →
  `${EDDY_API_ORIGIN}/api/ds/organization/{slug}/id`. Response shape:
  `{ currentShortName: string, organizationUuid: string }` — `404`/empty for unknown
  slugs.
- `scrape()` ordering: build the HTTP client first, then resolve the tenant —
  UUID paths unchanged, falling back to a single slug-lookup GET.
- `tenantFromUrl` gains a sibling that returns the first non-UUID `/careers/{…}`
  segment as the slug candidate (URL-decoded); `resolveTenant` returns `{ uuid }` or
  `{ slug }` so `scrape()` can decide whether the lookup is needed.
- The resolved UUID feeds the existing `eddyJobsListUrl`/`eddyJobDetailUrl`/
  `eddyJobPageUrl` paths unchanged — `jobUrl`, `atsId`, and `companyName` remain
  UUID-keyed.

## 5. Test Plan

- Mocked unit tests (`__tests__/eddy.slug-resolution.spec.ts`):
  - bare vanity `companySlug` → slug-lookup GET → jobs list fetch with resolved UUID.
  - `companyUrl` `/careers/{slug}/preview/embed` → same resolution.
  - UUID `companySlug` → **no** lookup call issued.
  - lookup 404 / error → empty result, no throw.
  - lookup returns a non-UUID body → empty result.
- Live-verified during implementation: `hypercraftusa` resolves to
  `d7e3b662-b7f9-458c-8a91-34374094c69f` → 3 open roles.
