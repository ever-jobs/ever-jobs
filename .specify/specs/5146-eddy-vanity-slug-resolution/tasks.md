# Tasks: 5146 — Eddy vanity-slug tenant resolution

## Ordered tasks

- [x] **T1 — constants + types.** Add `eddyOrganizationIdUrl(slug)` to
  `eddy.constants.ts` (`/api/ds/organization/{slug}/id`) and
  `EddyOrganizationIdResponse` (`{currentShortName, organizationUuid}`) to
  `eddy.types.ts`. *Acceptance:* exports compile; URL encodes the slug.

- [x] **T2 — service: client-first resolution + slug lookup.** In `scrape()`, build
  the HTTP client before tenant resolution. Extend `resolveTenant` to return the
  slug candidate when no UUID is found (bare non-UUID `companySlug`, or first
  non-UUID `/careers/{…}` segment of an Eddy-host URL). Add
  `resolveSlugToUuid(client, slug)` — `GET /api/ds/organization/{slug}/id`,
  never throws, validates the returned `organizationUuid` is UUID-shaped, tries
  the slug as-given then lowercased. *Acceptance:* `hypercraftusa` and
  `/careers/hypercraftusa/preview/embed` both resolve to
  `d7e3b662-b7f9-458c-8a91-34374094c69f`; UUID inputs make zero extra calls;
  unresolvable slugs → empty.

- [x] **T3 — mocked unit tests.** `__tests__/eddy.slug-resolution.spec.ts`: bare
  slug resolves + fetches list by UUID; embed URL resolves; UUID slug issues no
  lookup; lookup 404 → empty; non-UUID body → empty. *Acceptance:* suite green.

- [x] **T4 — docs.** `docs/index.md` spec row, `docs/log.md` entry.
  *Acceptance:* `npm run lint:docs` clean.

- [x] **T5 — verify + ship.** `npx jest source-ats-eddy`,
  `npx tsc --project tsconfig.typecheck.json --noEmit`, commit
  (`feat(plugin/source-ats-eddy): resolve vanity slugs to org UUIDs (spec 5146)`),
  push, PR to develop. *Acceptance:* green; PR open.
