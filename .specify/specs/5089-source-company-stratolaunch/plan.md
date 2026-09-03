# Plan: 5089 — Source Company Plugin: Stratolaunch

| Field        | Value        |
| ------------ | ------------ |
| Spec         | spec.md      |
| Created      | 2026-08-30   |
| Last updated | 2026-08-30   |

## Phases

1. **Scaffold package (`packages/plugins/source-company-stratolaunch/`).**
   Add `package.json`, `tsconfig.json`, `src/index.ts`,
   `src/stratolaunch.module.ts`, `src/stratolaunch.service.ts`, and a captured
   Greenhouse API fixture (`__tests__/fixtures/stratolaunch-jobs.json`).

2. **Registration.** Add `Site.STRATOLAUNCH` to
   `packages/models/src/enums/site.enum.ts`, import/export `StratolaunchModule`
   in `packages/plugins/index.ts`, and add the matching path alias to
   `tsconfig.base.json` and `jest.config.js`.

3. **Service implementation (`stratolaunch.service.ts`).** Fetch the
   Greenhouse board with `content=true`, map the response to `JobPostDto`,
   apply `resultsWanted` / `searchTerm` / `location` filters, and handle errors
   gracefully.

4. **Unit tests (`__tests__/stratolaunch.service.spec.ts`).** Cover module
   registration, full fixture mapping, `resultsWanted` cap, `searchTerm` and
   `location` filters, `isRemote` detection, title/department trim, and error
   handling.

5. **Docs and Spec Kit.** Update `docs/index.md` and `docs/log.md` with Spec
   5089.

6. **Verification.** Run `tsc --noEmit` and the plugin Jest suite.

## Packages touched

- `packages/plugins/source-company-stratolaunch`
- `packages/models`
- `packages/plugins`

## Risks

- If the Greenhouse board slug or API shape changes, the plugin will need a
  follow-up fix.
- Large `content` payloads may approach the default HTTP timeout; the shared
  `HttpClient` timeout is configurable per call.
