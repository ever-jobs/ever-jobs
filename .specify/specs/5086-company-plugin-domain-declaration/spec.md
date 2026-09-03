# Spec: 5086 — Company plugins declare the domains they serve

| Field          | Value                                 |
| -------------- | ------------------------------------- |
| Spec ID        | 5086                                  |
| Slug           | company-plugin-domain-declaration     |
| Status         | done                                  |
| Owner          | agent                                 |
| Created        | 2026-06-28                            |
| Last updated   | 2026-06-28                            |
| Supersedes     | (none)                                |
| Related specs  | 5069, 5070                            |

## 1. Problem Statement

Spec 5070 lets a caller address a company plugin by domain: `companyDomain: ["boomsupersonic.com"]`
resolves to `Site.BOOM_SUPERSONIC`. Resolution is pure string math (Spec 5069): lower-case, strip a
leading `www.`, strip a trailing `.com`, replace remaining dots with underscores. It works only when
the plugin's `Site` token happens to equal the token derived from the company's domain.

Many company plugins are named after their **ATS board slug**, not their domain, because that is the
identifier visible in the source they scrape. Two registered examples:

| plugin | `Site` token | company domain | derived token | resolves? |
| --- | --- | --- | --- | --- |
| `source-company-stokespacetechnologies` | `stokespacetechnologies` | `stokespace.com` | `stokespace` | no |
| `source-company-vardaspace` | `vardaspace` | `varda.com` | `varda` | no |

Calling with those domains fails before any scrape:

```
400 domain `stokespace.com` → token `stokespace` is not a registered plugin
```

while the same board returns 49 and 63 jobs when addressed by `siteType`. The 400 is correct given
what the server knows — nothing in the plugin states which company it serves. The plugin only ever
mentions its board slug; the company's own domain appears nowhere in the package, so no amount of
string manipulation can connect the two.

Today's escape hatch is `DOMAIN_TO_TOKEN_EXCEPTIONS` in `site-from-domain.ts`, a two-entry map
(`divergent.us` → `divergent`, `nuro.ai` → `nuro`) added with Spec 5070. It is structurally
one-behind: each new mismatch surfaces as a rejected request, is diagnosed by hand, and is fixed by
editing a central file no plugin author reads. 808 of the 1,540 `source-company-*` plugins are
Greenhouse-backed and many are slug-named, so the map is not converging.

## 2. Goals

- A company plugin can state the domains it serves, next to the rest of its metadata.
- `companyDomain` resolution consults those declarations before falling back to the string rule.
- One plugin can declare several domains (acquisitions, rebrands, legacy or marketing hosts).
- `DOMAIN_TO_TOKEN_EXCEPTIONS` is retired, its two entries migrated to declarations.
- Nothing that resolves today changes.

## 3. Non-Goals

- **No plugin, folder, or `Site` token renames.** Spec 5069 kept upstream-authored tokens deliberately;
  this spec keeps them and adds a declaration instead. Renaming remains rejected: it churns
  upstream-authored packages and only ever fixes the plugins someone has already noticed.
- **No bulk declaration campaign.** The field is optional; the 1,536 company plugins that resolve
  today are untouched and keep resolving by the string rule.
- No change to `siteType`, `companySlug` or `companyUrl` handling.
- No change to how an unresolved domain is reported: it still throws `BadRequestException` naming the
  domain and the derived token.
- No new endpoint exposing the registry. Nothing needs one; adding it would be speculative.
- No inference of a company domain from a plugin's scraped URLs. That is a guess, and a wrong guess
  routes one company's request to another company's board.

## 4. Design

### 4.1 The declaration

```ts
export interface IPluginMetadata {
  site: Site;
  name: string;
  category: PluginCategory;
  isAts?: boolean;
  /** Company domains this plugin serves, e.g. ['stokespace.com']. */
  companyDomains?: string[];
  description?: string;
}
```

- **Optional.** Absent means "resolve me by the string rule", i.e. today's behavior.
- **An array**, because one plugin can legitimately serve several hostnames: a company that acquired
  another and kept its domain, a rebrand whose old host still redirects, a marketing domain distinct
  from the corporate one. This is a property of the company, not of the caller — callers address one
  domain at a time.
- **Hosts, not URLs.** Values are normalized on registration, so `https://www.acme.com/careers`,
  `www.acme.com` and `acme.com` all index as `acme.com`.

### 4.2 The index lives in `PluginRegistry`

`siteFromDomain` stays a pure function in `@ever-jobs/common` with no registry access — it cannot see
plugin metadata and should not learn to. `PluginRegistry` already holds
`metadataMap: Map<Site, IPluginMetadata>`, so it gains a parallel domain index built in `register()`:

```ts
siteForDomain(domainOrUrl: string): Site | undefined
```

A second plugin claiming a host already claimed by another logs a warning naming both sites, in the
spirit of the existing `Overwriting existing scraper for site:` warning. First declaration wins, so a
later duplicate cannot silently steal another company's traffic.

`normalizeCompanyHost` is exported from `@ever-jobs/common` and used by both the registry index and
`deriveSiteToken`, so a declaration and a derivation can never disagree about what the host is.

### 4.3 Resolution order

In `JobsService.resolveCompanyDomains`, per domain:

1. `registry.siteForDomain(domain)` — a declaration by the plugin that owns the domain.
2. `siteFromDomain(domain)` — the Spec 5069 string rule.
3. otherwise unresolved → `BadRequestException`, message unchanged.

Only step 1 is new, and it is additive: a domain that resolves today takes the same path it takes
now unless some plugin has explicitly claimed it.

### 4.4 Retiring the exceptions map

`DOMAIN_TO_TOKEN_EXCEPTIONS` is deleted and its entries become declarations **in the same change**,
never before, or `divergent.us` and `nuro.ai` would start failing.

| plugin | declares |
| --- | --- |
| `source-company-stokespacetechnologies` | `['stokespace.com']` |
| `source-company-vardaspace` | `['varda.com']` |
| `source-company-divergent` | `['divergent.us']` |
| `source-company-nuro` | `['nuro.ai']` |

Why retire rather than keep both mechanisms: two sources of truth for one question require a
precedence rule maintained forever; the map is central, so it drifts while plugins stay silent; and
its entries are declarations in disguise — migrating them loses nothing. Editing the four
upstream-authored packages is a one-line addition inside an existing decorator, not a rename.

## 5. Changes

1. `packages/plugin/src/interfaces/plugin-metadata.interface.ts` — `companyDomains?: string[]`.
2. `packages/common/src/utils/site-from-domain.ts` — export `normalizeCompanyHost`; delete
   `DOMAIN_TO_TOKEN_EXCEPTIONS`.
3. `packages/plugin/src/registry/plugin-registry.service.ts` — domain index + `siteForDomain`,
   duplicate-claim warning.
4. `apps/api/src/jobs/jobs.service.ts` — consult the registry before the string rule.
5. Four plugin decorators — one line each.
6. `AGENTS.md` §5 — new company plugins whose token is not domain-derived declare `companyDomains`.

## 6. Test Plan

- A declared domain resolves to its site; `www.`, scheme and path forms all resolve.
- A plugin declaring two domains resolves from both.
- An undeclared domain still resolves by the string rule (`boomsupersonic.com`).
- `divergent.us` and `nuro.ai` resolve after the map is gone.
- `stokespace.com` and `varda.com` resolve to their slug-named plugins.
- An unresolvable domain still throws, with the derived token in the message.
- A declaration wins over a string-rule match for the same host.
- Registering two plugins that claim one host warns and keeps the first.
- No two registered plugins declare the same host (guards a typo'd declaration, which would otherwise
  misroute silently).
- `npx tsc --noEmit` clean; `npm run lint:docs` clean.
