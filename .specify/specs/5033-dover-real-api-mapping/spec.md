# Spec: 5033 — Dover real API mapping (full rewrite)

| Field | Value |
| --- | --- |
| Spec ID | 5033 |
| Slug | dover-real-api-mapping |
| Status | implemented |
| Owner | agent |
| Created | 2026-06-28 |
| Last updated | 2026-06-28 |
| Related specs | 5018, 5028, 5032 |

## Problem

The Dover plugin (created in the 10-adapter batch, Specs 355–364) never resolves
a board slug to a careers-page client id. It calls

```
GET /api/v1/careers-page/{slug}
```

treating the board **slug** as the careers-page id, but that endpoint expects the
careers-page **client id** (a UUID), so it 404s for any slug; the plugin swallows
the 4xx and falls back to scanning the board HTML for schema.org JSON-LD, which is
empty on the client-rendered SPA shell — so the result is empty.

Verified read-only via the fetch1 harness against 4 live Dover boards
(gradientrobotics, Mersenne Labs, createme, somewear-labs) carrying **25 open
roles** — the plugin returns **0** for all.

## Scope

Full rewrite of `dover.service.ts` (and the constants/types that model the
surface) onto Dover's real, public, unauthenticated REST flow:

- **Resolve.** Map the addressing token to a careers-page client id:
  - a careers-page UUID → `GET /api/v1/careers-page/{id}` → `{ id, name, slug }`;
  - otherwise try slug variants → `GET /api/v1/careers-page-slug/{slug}` →
    `{ id, name, slug }`. Dover slugs derive from the company name
    inconsistently ("Mersenne Labs" → `mersennelabs` but "Somewear Labs" →
    `somewear-labs`), so we try the raw token, lowercased, alnum-stripped, and
    hyphenated forms.
- **List.** `GET /api/v1/careers-page/{clientId}/jobs` →
  `{ count, next, results: [{ id, title, locations, workplace_type, is_sample }] }`;
  follow the `next` cursor up to `resultsWanted`. Exclude Dover's seeded
  `is_sample` demo roles.
- **Detail overlay.** `GET /api/v1/inbound/application-portal-job/{jobId}` →
  `{ client_name, title, user_provided_description, locations, workplace_type,
  created, compensation: { lower_bound, upper_bound, currency_code,
  salary_range_type, employment_type } }`.
- **Company name.** From the detail's `client_name` (the real display name),
  falling back to the careers-page `name`. **Never the slug** (the old code
  title-cased the slug).
- **Description.** The detail's `user_provided_description` (full HTML body),
  formatted per `descriptionFormat`.
- **Compensation.** Structured-first (Spec 5018): build a `CompensationDto` from
  the detail's `compensation` block (`lower_bound`/`upper_bound`/`currency_code`,
  interval from `salary_range_type` via the shared `getCompensationInterval`) as
  `structured` into `resolveCompensation`, with the formatted body as the text
  fallback; `salarySource` `'structured'` / `'description'`.
- **Location.** First structured `locations[].location_option`
  (`city`/`state`/`country`) → `LocationDto`; `Remote` city when the role is
  remote and carries no structured place.
- **isRemote.** From `workplace_type === 'REMOTE'`, a `REMOTE` location type, or
  remote text in the title.
- **employmentType.** Normalise the detail's `compensation.employment_type`
  (`FULL_TIME` → `Full Time`, `INTERNSHIP` → `Internship`).
- **Token resolution.** From `companySlug` (a bare slug, careers-page UUID, or
  company display name) or a board `companyUrl` (`/jobs/{slug}`,
  `/apply/{Name}`, or `/{company}/careers/{uuid}`).
- **Graceful degradation.** An unknown tenant (HTTP 4xx on resolve / list), a
  removed role (4xx on detail), or a malformed payload yields an empty / partial
  result rather than throwing, so one tenant never nukes a batch.

No new `@ever-jobs/common` helper is needed: the structured-compensation
precedence reuses `resolveCompensation` (Spec 5018) and the interval mapping
reuses `getCompensationInterval` (`@ever-jobs/models`).

## Non-goals

- No change to the public `JobPostDto` shape.
- No change to the shared `resolveCompensation` (Spec 5018) or interval mapping.
- No plugin imports another plugin.
- No live-network dependency in unit tests (the live e2e suite stays separate and
  zero-tolerant).
- Name-form board identifiers that are not slug-resolvable by the public API are
  out of scope — they degrade to empty, as before.

## Contracts

- A tenant whose slug resolves to `{ id }` and whose
  `careers-page/{id}/jobs` returns `results: [{ id, title, workplace_type,
  locations }]` yields one `JobPostDto` per unique non-sample `id` (capped at
  `resultsWanted`).
- `companyName` comes from the detail's `client_name` (e.g. `Gradient Robotics`),
  not the slug.
- `description` is the detail's `user_provided_description`, format-converted.
- `compensation` is structured (from `compensation.lower_bound`/`upper_bound`)
  when present, else parsed from the body; `salarySource` records which.
- A careers-page UUID identifier resolves directly and never hits the
  slug-resolution endpoint.
- A role whose detail 404s still emits from its listing fields (title, url,
  company name from the careers-page `name`).

## Test plan

- **Dover unit (mocked HTTP)** — `dover.service.spec.ts`:
  - resolve slug → list → overlay detail: asserts `companyName` from
    `client_name`, structured-first compensation (interval `YEARLY`, USD bounds),
    `isRemote` false for ONSITE, normalised `employmentType`, location,
    `datePosted` from `created`, `jobUrl`, ids;
  - careers-page UUID resolves directly (no slug call);
  - hyphenated slug-variant fallback for a multi-word name;
  - `REMOTE` workplace → `isRemote` + `Remote` location;
  - `is_sample` demo roles excluded;
  - detail 4xx → still emits from the listing;
  - unresolvable tenant → empty; no input → empty (no HTTP);
  - `/jobs/{slug}` `companyUrl` parsing.
- **Dover e2e (live, zero-tolerant)** — header refreshed to the real contract;
  `KNOWN_TENANT` set to a resolvable slug; shape assertions only when jobs are
  returned.

## Risks

- The board → API contract is undocumented (reverse-engineered from a read-only
  probe). The adapter degrades to empty on any envelope/token drift rather than
  throwing, so drift is a silent zero (the same failure mode it replaces) — but
  the live e2e suite and the fetch1 harness probe will surface it.
- Slug derivation is heuristic; the variant set covers the observed tenants, but
  a slug that matches none of the variants degrades to empty (a careers-page UUID
  or board URL always resolves deterministically).
