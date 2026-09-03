# Plan: 1687 — the browser goes where the plugin says, not where the caller says

| Field        | Value                               |
| ------------ | ----------------------------------- |
| Spec ID      | 1687                                |
| Status       | done                                |
| Last updated | 2026-09-03                          |

## Approach

Follow the shape #47 already established for `source-ats-submit4jobs`: a predicate in the
plugin's own `*.constants.ts`, called at every point an untrusted string would otherwise reach
the network, failing closed with a warning that names the rejected value.

Both new plugins descend from the same template, so the same four edits apply to each:

1. `isAllowed…Url(url)` in `*.constants.ts` — `new URL()`, http(s) only, `hostname` equal to the
   registrable domain or a subdomain of it.
2. `startUrl(input)` — replaces the inline `input.companyUrl || DEFAULT`; rejects off-domain.
3. Detail-loop guard — skip a card whose `detailUrl` is off-domain.
4. Detail-loop `try`/`catch` + an `N of M` summary.

RDW additionally gets `unfilteredBudget(input)`, consulted at the top of the page loop and the
card loop.

Stratolaunch gets a pass cap on `decodeFully` and a `^[A-Za-z0-9_-]+$` check on the board token
before it is interpolated into the API path. SuccessFactors gets one branch: when a CSB base was
resolved, an empty result is `empty` naming the portal, not `bad_input`.

The Spec 5086 catalogue guard is corrected in the same change: it flagged one plugin declaring
both `example.com` and `www.example.com` as conflicting *with itself* (`X: dir and dir`), because
it compared against the map without checking the owner. `PluginRegistry.indexCompanyDomains`
already tolerates that case (`owner !== meta.site`); the test is now consistent with it.

## Files

| File | Change |
| ---- | ------ |
| `packages/plugins/source-company-rdw/src/rdw.constants.ts` | `RDW_ALLOWED_HOST`, `isAllowedRdwUrl` |
| `packages/plugins/source-company-rdw/src/rdw.service.ts` | `startUrl`, `unfilteredBudget`, href guard, per-card `try`, `empty` diagnostic |
| `packages/plugins/source-company-trossenrobotics/src/trossenrobotics.constants.ts` | `TROSSENROBOTICS_ALLOWED_HOST`, `isAllowedTrossenroboticsUrl` |
| `packages/plugins/source-company-trossenrobotics/src/trossenrobotics.service.ts` | `startUrl`, href guard, per-card `try`, `empty` diagnostic |
| `packages/plugins/source-company-stratolaunch/src/stratolaunch.service.ts` | `MAX_ENTITY_DECODE_PASSES`, `GREENHOUSE_BOARD_RE`, `boardFromUrl` |
| `packages/plugins/source-ats-successfactors/src/successfactors.service.ts` | `empty` for a verified-but-empty CSB portal |
| `packages/plugin/__tests__/plugin-registry-domains.spec.ts` | same-plugin duplicate is not a conflict |

New suites live in `*.hardening.spec.ts` files rather than in the fork-authored specs, so the
next fork sync does not conflict on them.

## Verification

`tsc --noEmit -p tsconfig.base.json`, the six touched suites, `npm run lint:docs`,
`npm run test:scripts`.
