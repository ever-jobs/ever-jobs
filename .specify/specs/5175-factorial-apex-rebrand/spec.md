# Spec: 5175 — factorial-apex-rebrand

| Field | Value |
| --- | --- |
| Spec ID | 5175 |
| Slug | factorial-apex-rebrand |
| Status | draft |
| Owner | agent |
| Created | 2026-10-10 |

## Problem

Factorial rebranded its tenant career-board domain:
`{slug}.factorialhr.com` now 301-redirects to `{slug}.factorial.com`, and the
index page emits `data-job-postings-url` values as absolute URLs on the new
apex — e.g. `https://jobs-tendencys.factorial.com/job_posting/ai-developer-323152`.
Verified live 2026-10-10: `jobs-tendencys.factorialhr.com` → 301 →
`jobs-tendencys.factorial.com` (200), page structure unchanged.

Two stale literals follow:

- `FACTORIAL_HOST_TEMPLATE = 'https://{slug}.factorialhr.com'` — still works
  today only because the old sub-domain redirects; the canonical host is now
  `factorial.com`.
- The e2e spec asserts `jobUrl.includes('factorialhr.com')` — guaranteed to
  fail now that embedded job URLs carry the new apex. This is the observed
  CI break on develop.

The scrape itself is unaffected — the redirect is followed and job URLs are
parsed verbatim from the page. No field mapping changes.

## Scope

- `factorial.constants.ts`: canonical apex `factorial.com`; legacy
  `factorialhr.com` kept as a fallback host template; docblock updated.
- `factorial.service.ts`: try host templates in order (canonical first,
  legacy last); the winning host supplies the sitemap fetch.
- `factorial.e2e-spec.ts`: replace the domain-literal assertion with a
  path-shape assertion (`/job_posting/` pathname) that survives rebrands and
  custom-domain tenants.
- New unit suite with a captured index-page fixture covering
  `parseIndexPage` → `buildJobPost`, the host fallback, and error paths —
  the plugin's first non-live coverage.

## Non-goals

- No `dedupKey` work — the key is `company|title|location` (Spec 1721) and
  `atsId` is the numeric path token; neither contains the host, so legacy
  jobs keep their keys automatically.
- No location-mapper adoption — the feed carries a text office label plus a
  select-option lookup, not a structured location object.
- No custom-domain resolution changes.

## Contracts

- First fetch attempt goes to `https://{slug}.factorial.com/`; only on
  transport failure or empty body does the scrape retry
  `https://{slug}.factorialhr.com/`.
- Sitemap is fetched from whichever host served the index.
- `jobUrl`, `applyUrl` remain verbatim page values (any apex, incl. custom
  domains).

## Test plan

- Unit: fixture index page → 2 jobs with id/atsId/title/companyName/jobUrl/
  applyUrl/datePosted/isRemote/department/location asserted; canonical-host
  fetch attempted first; legacy fallback when canonical rejects; both-hosts-
  down → `[]`; missing slug/URL → `[]`.
- E2E: existing suite unchanged except the assertion fix.
