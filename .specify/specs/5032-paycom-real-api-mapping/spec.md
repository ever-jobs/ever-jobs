# Spec: 5032 — Paycom real API mapping (full rewrite)

| Field | Value |
| --- | --- |
| Spec ID | 5032 |
| Slug | paycom-real-api-mapping |
| Status | implemented |
| Owner | agent |
| Created | 2026-06-28 |
| Last updated | 2026-06-28 |
| Related specs | 5018, 5022, 5028 |

## Problem

The Paycom plugin (created in the 10-adapter batch, Specs 355–364) returns
**zero jobs for every tenant** — it is completely non-functional. Verified on
five live tenants (Boxabl, Spudnik, Guardian Bikes, Aperture, Prefix), each with
open roles (8 / 1 / 5 / 13 / 15 = 42 real jobs); the plugin yields 0 across the
board. It is broken at four compounding points, with wrong field mapping behind
them (ADP-class, cf. Spec 5028):

1. **Token never extracted.** The clientkey-addressed board page is a
   client-rendered React app that boots a public, read-only bearer into
   `configsFromHost.sessionJWT`. The old `PAYCOM_TOKEN_REGEX` only matched
   `"token"` / `"accessToken"` / a `Bearer` literal, so `extractToken` returned
   null and the run ended empty.
2. **Search payload incomplete.** The search endpoint returns an empty set
   unless the full `filtersForQuery` object is POSTed alongside `skip`/`take`
   (a bare `{skip,take}` yields zero — verified). The old code sent a bare
   `{skip,take}`.
3. **Search envelope mismatch.** The real key is `jobPostingPreviews`
   (+ `jobPostingPreviewsCount`); the old `parsePreviews` looked for
   `results` / `data` / `items` / `jobPostings`.
4. **Detail envelope mismatch.** `GET /api/ats/job-postings/{id}` returns the
   posting **wrapped** in `{ jobPosting: {…} }`; the old code read
   `response.data` directly.

Behind those, the field mapping was wrong: `datePosted` lives **only** inside
each detail's `googleJobJson` schema.org string (preview `postedOn` / detail
`startDate` are empty); the tenant display name is behind a dedicated
`GET /api/ats/company-name` endpoint (the old code derived it from the
clientkey); and the `fromJsonLd` fallback targeted the legacy `ViewJobDetails`
page, which now serves a no-JS shell.

## Scope

Full rewrite of `paycom.service.ts` (and the constants/types that model the
surface) onto the real applicant-tracking JSON API:

- **Token.** Read the public bearer from the board page via
  `"sessionJWT":"{JWT}"` (`PAYCOM_SESSION_JWT_REGEX`).
- **Search.** `POST /api/ats/job-posting-previews/search` with
  `{ skip, take, filtersForQuery: PAYCOM_SEARCH_FILTERS }` (the full
  empty-filters object) and the bearer; parse the `jobPostingPreviews` envelope.
- **Detail.** `GET /api/ats/job-postings/{id}`; unwrap `response.data.jobPosting`.
- **Company name.** `GET /api/ats/company-name` (bearer) → `companyName`.
- **Description.** Concatenate the two visible HTML sections
  (`description` + `qualifications`); fall back to the schema.org node's
  description. Format per `descriptionFormat`.
- **datePosted / URL / structured pay.** Parse the detail's `googleJobJson`
  schema.org `JobPosting` node (a JSON *string*) via the new shared
  `jobPostingLdFromNode` (Spec 5022) for `datePosted`, the canonical `url`, and
  any structured `baseSalary`.
- **Compensation.** Structured-first (Spec 5018): `baseSalary` →
  `jobPostingLdToCompensation` as `structured` into `resolveCompensation`, with
  the formatted body as the text fallback; `salarySource` `'structured'` /
  `'description'`.
- **isRemote / workFromHomeType.** From the `remoteType` code (`R`/`F`/`H`/`T` =
  non-onsite) or remote text in the title/location; `H` → `Hybrid`, else
  `Remote`.
- **Clientkey resolution.** From `companySlug` (a bare clientkey) or a board
  `companyUrl` (clientkey in the `/portal/{KEY}/` path or a `?clientkey=` query).
- **Graceful degradation.** A missing token, an unknown clientkey (HTTP 4xx),
  or a malformed payload yields an empty / partial result rather than throwing.

A small reusable helper is added to `@ever-jobs/common`:
`jobPostingLdFromNode(value)` maps an already-parsed (or JSON-string) schema.org
`JobPosting` to a `JobPostingLd`, reusing the Spec 5022 container-unwrapping and
field mapping without a `<script>` round-trip (which would truncate on a literal
`</script>` in the body).

## Non-goals

- No change to the public `JobPostDto` shape.
- No change to the shared `resolveCompensation` / `jobPostingLdToCompensation`
  helpers (Spec 5018) or the ld+json node mappers (Spec 5022) beyond the additive
  `jobPostingLdFromNode` export.
- No plugin imports another plugin.
- No live-network dependency in unit tests (the live e2e suite stays separate and
  zero-tolerant).

## Contracts

- A tenant whose board boots `"sessionJWT":"…"` and whose search returns
  `jobPostingPreviews: [{ jobId, jobTitle, locations, remoteType }]` yields one
  `JobPostDto` per unique `jobId` (capped at `resultsWanted`).
- `companyName` comes from `/api/ats/company-name` (e.g. `Guardian Bikes`), not
  the clientkey.
- `description` is `description` + `qualifications` (plain/markdown/HTML per
  `descriptionFormat`); a detail-fetch failure degrades to a preview-only job
  with `description: null`.
- `datePosted` is the `googleJobJson` `datePosted` (YYYY-MM-DD); `jobUrl` /
  `applyUrl` is the `googleJobJson` `url`, else a constructed
  `/portal/{KEY}/jobs/{jobId}`.
- `compensation` is structured from the `googleJobJson` `baseSalary` when
  present (`salarySource: 'structured'`), else parsed from the body text
  (`salarySource: 'description'`), else absent.
- A board with no `sessionJWT`, an unknown clientkey (board 404), or a missing
  `companySlug`/`companyUrl` yields an empty result (no throw); the search API is
  never called without a token.

## Test plan

- **Paycom service (mocked, deterministic)** — `paycom.service.spec.ts`:
    - maps the real envelope, token, company-name, body (description +
      qualifications), location (ZIP stripped), employment type, department,
      `datePosted` from `googleJobJson`, ids/urls;
    - asserts the search POST carries the full `filtersForQuery` and the bearer;
    - structured compensation from `googleJobJson` `baseSalary`
      (`salarySource: 'structured'`);
    - remote detection + `workFromHomeType` from the `remoteType` code;
    - clientkey resolution from a board `companyUrl` (portal path and query);
    - empty results when no `sessionJWT`, unknown tenant (board 404), and no
      slug/url; preview-only fallback when the detail fetch fails; dedupe by
      `jobId` + `resultsWanted` cap.
- **Paycom e2e (live, zero-tolerant)** — existing suite kept; shape assertions
  only when jobs are returned.
- **Common** — `jobPostingLdFromNode`: maps an object, a JSON string, an
  `@graph` container, and structured `baseSalary`; null for empty / malformed /
  non-`JobPosting` input.

## Risks

- The board → API contract is undocumented (reverse-engineered from a read-only
  probe). The adapter degrades to empty on any envelope/token drift rather than
  throwing, so drift is a silent zero (the same failure mode it replaces) — but
  the live e2e suite and the fetch1 harness probe will surface it.
- Paycom tenants observed carry no structured `baseSalary` (pay is free-text or
  absent); structured-first is wired for correctness/consistency and exercised by
  a synthetic test, with the text fallback covering the live tenants.
