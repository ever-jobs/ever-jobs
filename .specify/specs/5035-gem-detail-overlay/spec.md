# Spec: 5035 — Gem detail overlay (body, posted date, pay, employment type, URL)

| Field | Value |
| --- | --- |
| Spec ID | 5035 |
| Slug | gem-detail-overlay |
| Status | implemented |
| Owner | agent |
| Created | 2026-06-28 |
| Last updated | 2026-06-28 |
| Related specs | 5018, 5029, 5030, 5034 |

## Problem

`source-ats-gem` runs only the `JobBoardList` GraphQL op, which carries no body,
posted date, or pay — those live on the per-posting `ExternalJobPostingQuery`
detail. So `description`, `datePosted`, and `compensation` are always absent. It
also drops `employmentType` (the enum is right there in the list `job` node) and
builds a 404 job URL (`/{slug}/jobs/{extId}`; the canonical form is
`/{slug}/{extId}`).

Verified read-only against 6 live Gem boards (firestorm, andrenam, albacore,
astroforge-io, 43north, voltairlabs-com) carrying **100 open roles**: job counts
and matching are correct, but every sampled job differs on `description`,
`datePosted`, `employmentType`, and `jobUrl`.

## Scope

- **Detail overlay.** For each posting kept after the `resultsWanted` cap, issue
  the batched `ExternalJobPostingQuery` (`oatsExternalJobPosting(boardId, extId)`)
  under bounded concurrency (`Promise.allSettled`) and map:
  - `description` — `descriptionHtml` (full body), formatted per
    `descriptionFormat` (markdown default);
  - `datePosted` — `firstPublishedTsSec` (Unix **seconds**) → `Date`;
    `startDateTs` is the fallback;
  - `compensation` — `compensationHtml` is free text (e.g.
    "$170,000 – $200,000 per year"); Gem exposes no structured bounds, so it is
    parsed via the shared salary extractor (`resolveCompensation`, Spec 5018).
- **employmentType.** Humanise the list `job.employmentType` enum
  (`FULL_TIME` → `Full-time`); map to `jobType` via `getJobTypeFromString`.
- **Job URL.** `https://jobs.gem.com/{slug}/{extId}` (drop the `/jobs/` segment).
- **Graceful degradation.** A failed detail fetch yields the list-only fields for
  that job; one role never nukes the batch.

`companyName` already reads `jobBoardExternal.teamDisplayName` (e.g. "AstroForge",
not the slug) and is unchanged; locations, `isRemote`, and `department` are
unchanged.

## Non-goals

- No change to the public `JobPostDto` shape.
- No structured compensation source — Gem exposes only free-text
  `compensationHtml`; a posting with no recognisable range reports no pay.
- No live-network dependency in unit tests.

## Contracts

- `description` is the detail's `descriptionHtml`, format-converted; `null` when
  the detail fetch fails or carries no body.
- `datePosted` is `firstPublishedTsSec` (or `startDateTs`) as a `Date`; `null`
  when neither is present.
- `compensation` is parsed from `compensationHtml`; absent when no range parses.
- `employmentType` is the humanised enum; `jobType` is the mapped value.
- `jobUrl` is `https://jobs.gem.com/{slug}/{extId}`.
- A board with N roles still yields N `JobPostDto` (capped at `resultsWanted`).

## Test plan

Unit (`packages/plugins/source-ats-gem/__tests__/gem.service.spec.ts`,
mocked HTTP):

- overlays `description`, `datePosted`, and `compensation`, maps `employmentType`,
  and emits the canonical `/{slug}/{extId}` URL;
- a posting with no detail node keeps its list-only fields (`description` /
  `datePosted` null);
- existing cases retained: happy-path mapping, `resultsWanted` cap, empty
  `jobPostings`, HTTP error caught, response-order tolerance, missing slug.
