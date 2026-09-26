# Plan: 1752 — ReliefWeb on API v2 (v1 is decommissioned)

| Field        | Value       |
| ------------ | ----------- |
| Spec ID      | 1752        |
| Spec         | spec.md     |
| Status       | Implemented |
| Created      | 2026-09-25  |
| Last updated | 2026-09-25  |

## Approach

1. **Read the current docs** (https://apidoc.reliefweb.int/ — home, parameters, fields
   tables): v2 is v1-compatible; appnames must be pre-approved since 2025-11-01; jobs carry
   `url`, `url_alias`, `body` (Markdown) and `body-html`.
2. **Confirm live, within budget** (3 GETs to api.reliefweb.int, 2 to reliefweb.int, ≥1 s
   apart): v2 with `appname=ever-jobs` → 403 "not an approved appname"; v1 → 410
   "decommissioned"; `/node/<open id>` → 301 to the alias; `/node/<closed id>` → 410 HTML
   with the alias as `rel=canonical`. One API GET left unused.
3. **Change the plugin**: v2 endpoint, `RELIEFWEB_APPNAME`, the 403 diagnostic, the
   `url_alias` → `url` → node link order, per-format description fields.
4. **Tests from the evidence**: the two live error bodies verbatim as fixtures; a v2 list
   fixture built from the field tables (real ids/aliases, documented as constructed).
5. **Docs**: README section, `.env.example`, index/log.

## Files

- `packages/plugins/source-reliefweb/src/reliefweb.constants.ts` — v2 URL, env name, default
  appname, docs URL, fields (+ `body-html`, `url_alias`), node fallback note.
- `packages/plugins/source-reliefweb/src/reliefweb.service.ts` — appname, 403 diagnostic,
  links, descriptions.
- `packages/plugins/source-reliefweb/src/reliefweb.types.ts` — v2 fields, error body.
- `packages/plugins/source-reliefweb/__tests__/reliefweb.v2.spec.ts` (new),
  `reliefweb.job-url.spec.ts` (v2 `href`, `url_alias` cases), `fixtures/` (3 JSON, new).
- `README.md` (ReliefWeb section), `.env.example` (`RELIEFWEB_APPNAME`).

## Risks

- **No live v2 payload.** The list fixture follows the documented fields; if v2's actual
  shape differs, the first run with an approved appname shows it (the e2e spec
  `reliefweb.e2e-spec.ts` exercises it, and is not run here because it calls the live API).
- **Quota.** ReliefWeb allows 1,000 calls/day and 1,000 entries per call; the plugin makes one
  call per scrape with `limit ≤ 100`.
- **Unapproved default.** Every scrape without `RELIEFWEB_APPNAME` costs one refused request
  (D-01 in spec.md).

## Verification

- `npx jest packages/plugins/source-reliefweb --testPathIgnorePatterns e2e-spec` → 13/13;
  against the pre-change `src/` → 6 of 13 fail.
- `npx jest scripts/__tests__/plugin-job-url-hosts.spec.ts` green.
- `npx tsc --project tsconfig.typecheck.json --noEmit`,
  `npx tsc --project apps/api/tsconfig.build.json --noEmit`.
