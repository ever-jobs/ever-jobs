# Plan: 5086 — Company plugins declare the domains they serve

| Field        | Value        |
| ------------ | ------------ |
| Spec         | spec.md      |
| Created      | 2026-06-28   |
| Last updated | 2026-06-28   |

## Phases

1. **Normalization helper (`@ever-jobs/common`).** Extract the existing host handling in
   `site-from-domain.ts` into an exported `normalizeCompanyHost` (scheme/path stripped, lower-cased,
   leading `www.` removed). Pure refactor, no behavior change; `deriveSiteToken` calls it.
2. **Metadata field (`@ever-jobs/plugin`).** Add optional `companyDomains?: string[]` to
   `IPluginMetadata`. Leaf addition, no consumer yet.
3. **Registry index (`@ever-jobs/plugin`).** Build a `Map<host, Site>` in `register()`, expose
   `siteForDomain()`, warn on a duplicate claim and keep the first.
4. **Resolution (`apps/api`).** `resolveCompanyDomains` consults `registry.siteForDomain()` before
   `siteFromDomain()`. Error path unchanged.
5. **Declarations + map removal.** Four plugin decorators gain one line each; delete
   `DOMAIN_TO_TOKEN_EXCEPTIONS` in the same commit as the two declarations that replace it.
6. **Tests + docs.** Registry unit tests, `JobsService` resolution tests, `site-from-domain` tests;
   `AGENTS.md` §5 convention; `docs/index.md`, `docs/log.md`.

## Packages touched

- `packages/common`
- `packages/plugin`
- `packages/plugins/source-company-{stokespacetechnologies,vardaspace,divergent,nuro}`
- `apps/api`

## Risks

- **New package edge.** `@ever-jobs/plugin` gains an import from `@ever-jobs/common` (for
  `normalizeCompanyHost`). `common` imports only `@ever-jobs/models`, so the graph stays acyclic. The
  alternative — duplicating ten lines of host normalization in the registry — risks a declaration and
  a derivation disagreeing about the same host, which is exactly the class of bug this spec removes.
- **A wrong declaration misroutes silently.** Nothing validates that a declared domain really belongs
  to that company, so a typo sends one company's request to another's board. Mitigated by the
  duplicate-host warning, first-declaration-wins, and a test asserting no two registered plugins claim
  the same host — but a plausible-looking wrong host in an otherwise unclaimed namespace is
  undetectable and stays the author's responsibility.
- **Registration order becomes observable** where two plugins claim one host. Deliberate: the
  alternative (last wins) makes the winner depend on discovery order, which is worse.
- **Upstream-authored files touched.** Four packages, one line each, inside an existing decorator
  object. Merges cleanly in practice; no rename, so no identifier churn.
- **Registry startup cost.** One `Map` insert per declared host at registration. With four
  declarations this is unmeasurable, and it stays O(declared hosts) rather than O(plugins).
