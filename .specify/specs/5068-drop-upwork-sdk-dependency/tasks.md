# Tasks — Spec 5068

- [x] Remove `@upwork/node-upwork-oauth2` from `package.json` dependencies.
- [x] Add `loadUpworkSdk()` lazy/guarded loader in `upwork.service.ts`; use it in
      `createApiClient` and before `new Graphql(api)`.
- [x] Wrap constructor `createApiClient` in try/catch (warn + stay unconfigured).
- [x] `npm install` to prune the lockfile (request stack removed, 0 additions).
- [x] `jest --testPathPatterns source-upwork` green (3/3).
- [x] `npm run build` green (mcp + api + cli).
- [x] Confirm `npm ls request tough-cookie @upwork/node-upwork-oauth2` absent.
- [x] Docs: `docs/log.md` top entry + `docs/index.md` reference.
