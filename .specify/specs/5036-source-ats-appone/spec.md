# Spec: 5036 — source-ats-appone (AppOne JSON REST plugin)

| Field | Value |
| --- | --- |
| Spec ID | 5036 |
| Slug | source-ats-appone |
| Status | implemented |
| Owner | agent |
| Created | 2026-06-28 |
| Last updated | 2026-06-28 |
| Related specs | 5018, 5035 |

## Problem

AppOne (`jobs.appone.com`, "Powered by Paychex Flex") has no plugin and no
`Site` enum value. It is the same vendor family as `source-ats-paychex` but a
distinct technical surface: the paychex plugin scrapes `applybypaychex.com` via
`sitemap.xml` + prerendered JSON-LD, whereas AppOne is an Angular SPA with no
sitemap and no JSON-LD — so it cannot be folded into `source-ats-paychex` and
needs its own plugin.

AppOne exposes two unauthenticated JSON REST endpoints:

- list: `GET https://jobs.appone.com/api/portal/v1/companyjobposts/{tenant}` →
  `{ companyName, clientId, jobPosts: [{ jobPostId, jobPostUrl, jobTitle,
  jobType, location, datePosted, workplaceType }] }`.
- detail: `GET https://apply.appone.com/api/apply/v2/jobposting/{jobPostId}` →
  adds the full plain-text `description`.

Verified read-only against 1 live AppOne tenant (vansaircraftcareers) carrying
**5 open roles**: the list carries every comparable field except the body; the
detail adds the body.

## Scope

- **New plugin** `packages/plugins/source-ats-appone` (`Site.APPONE = 'appone'`,
  registered in the four source-plugin places).
- **Tenant input.** `input.companySlug` (the careers-URL slug, e.g.
  `vansaircraftcareers`) or the last path segment of `input.companyUrl` on
  `jobs.appone.com`.
- **List + detail overlay.** Fetch the list, cap to `resultsWanted`, then overlay
  each kept posting with its `jobposting/{jobPostId}` detail under bounded
  concurrency (`Promise.allSettled`).
- **Mapping.**
  - `title` — `jobTitle`;
  - `companyName` — list `companyName` (e.g. "Van's Aircraft, Inc."), else the
    tenant slug;
  - `location` — `location` split into `{ city, state }` (e.g. "Aurora, OR");
  - `jobUrl` — `jobPostUrl`;
  - `datePosted` — list `datePosted` (ISO-8601) → `Date`;
  - `isRemote` — `workplaceType === 'REMOTE'` (or "remote" in the location text);
    `HYBRID` sets `workFromHomeType = 'Hybrid'`;
  - `employmentType` — `jobType` (e.g. "Full Time"); `jobType` via
    `getJobTypeFromString`;
  - `description` — the detail's plain-text body;
  - `compensation` — AppOne exposes no structured pay, so it is parsed from the
    description text via the shared salary extractor (`resolveCompensation`,
    Spec 5018).
- **Graceful degradation.** A failed detail fetch yields the list-only fields for
  that job; a failed list fetch yields an empty `JobResponseDto`. The scrape
  never throws.

## Non-goals

- No change to `source-ats-paychex` (distinct surface).
- No structured compensation source — AppOne exposes none; a posting with no
  recognisable range in its body reports no pay.
- No live-network dependency in unit tests.

## Contracts

- A tenant with N roles yields N `JobPostDto` (capped at `resultsWanted`).
- `id` is `appone-${jobPostId}`; `atsId` is `jobPostId`; `atsType` is `appone`.
- `description` is the detail body; `null` when the detail fetch fails.
- `datePosted` is the ISO list timestamp as a `Date`; `null` when absent.
- `compensation` is parsed from the description; absent when no range parses.
- Missing/unresolvable tenant → empty `JobResponseDto`, no HTTP call.

## Test plan

Unit (`packages/plugins/source-ats-appone/__tests__/appone.service.spec.ts`,
mocked HTTP):

- happy path — maps company / location (city+state) / employmentType / jobType /
  datePosted / canonical id and URL;
- `isRemote` from `workplaceType` REMOTE, and `HYBRID` → `workFromHomeType`;
- `resultsWanted` cap;
- detail overlay — plain-text `description`, `emails`, and parsed
  `compensation`; a posting with no detail keeps its list-only fields;
- tenant resolved from a `companyUrl`;
- empty `jobPosts` → empty response;
- list HTTP error caught → empty response.
