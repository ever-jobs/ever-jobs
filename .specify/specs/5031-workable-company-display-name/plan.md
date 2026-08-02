# Plan: 5031 — Workable company display name

| Field | Value |
| --- | --- |
| Spec ID | 5031 |
| Status | implemented |
| Created | 2026-06-28 |

## Phases

1. **Types** — add `name?: string | null` to `WorkableResponse`.
2. **Resolve display name** — in `scrape` (public path), compute
   `const companyName = data.name?.trim() || companySlug;` after reading the
   widget response.
3. **Map** — add a `companyName` parameter to `processJob` and use it for the
   `companyName` field; keep `companySlug` for the `jobUrl` fallback and other
   slug-derived fields.
4. **Test** — add deterministic cases (display name from widget `name`, slug
   fallback when absent); keep the existing public-path suites green.
5. **Verify** — run the `source-ats-workable` jest suite; typecheck the
   `apps/api` build; `lint:docs`.

## Packages touched

- `packages/plugins/source-ats-workable` (`src/workable.service.ts`,
  `src/workable.types.ts`, `__tests__/workable.service.spec.ts`).

## Risks

- None material. `processApiJob` (authenticated v3) is intentionally untouched —
  the v3 response carries no company name, so the slug remains its only value.
