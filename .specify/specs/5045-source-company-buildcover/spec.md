# Spec: 5045 — source-company-buildcover

| Field | Value |
| --- | --- |
| Spec ID | 5045 |
| Slug | source-company-buildcover |
| Status | implemented |
| Plugin | `packages/plugins/source-company-buildcover` |
| Category | `company` (single company — Cover / buildcover.com) |
| Related specs | 5042 (Terraform Industries company careers), 5044 (Notion company careers) |

## Problem

Cover (`buildcover.com`, a prefab-home builder in Los Angeles) hosts its careers
page on a custom Nuxt front-end with **no ATS** behind it — roles are content
documents in a **Sanity CMS** and the only way to apply is a single email
(`join@buildcover.com`). There was no adapter, so Cover's openings were not
ingested at all. The rendered `/careers` HTML is client-hydrated (no job data in
the static markup), so HTML scraping is unreliable.

## Key insight — read Sanity's public API, not the HTML

Cover's content is served by Sanity (`projectId n40cnr7v`, `dataset production`).
Sanity exposes an unauthenticated public query API, so the roles come back fully
structured with no headless browser and no HTML parsing:

```
GET https://n40cnr7v.apicdn.sanity.io/v2021-10-21/data/query/production?query=<GROQ>
```

One query returns every role plus the global apply email:

```
{
  "contactEmail": *[_type=="careersPage"][0].contactEmail,
  "careers": *[_type=="career"] | order(_createdAt desc){
    _id, title, "slug": slug.current, location, type, _createdAt, _updatedAt,
    overview, role, experience, extraSections, compensation
  }
}
```

Each `career` document carries `overview` / `role` / `experience` /
`extraSections` / `compensation` as **Portable Text** block arrays (rendered to
a markdown-ish description) plus scalar `title` / `location` / `type` /
`_createdAt`.

## Scope — one company plugin, NOT a shared "Sanity" ATS

This is a **single-company** plugin (like `source-company-terraformindustries`):
`projectId` / `dataset` / base URL are baked into constants; `companySlug` is
ignored; `category:'company'`.

Deliberately **not** wired like Notion/Greenhouse (one shared, parameterized
plugin). Sanity is a headless CMS: only the *transport* (the GROQ endpoint) is
uniform — the **schema is bespoke per project**. Cover's `_type=="career"` and
its field names are Cover's own content model; another Sanity-backed company
would have a different `projectId` *and* a different schema, so there is no
shared contract to parameterize by an id. If a second Sanity-backed company ever
appears, the reusable *mechanical* pieces (the GROQ client + the Portable-Text
walker) can be lifted into `@ever-jobs/common` then — YAGNI until then.

### Field mapping

| JobPostDto field | Source |
| --- | --- |
| `id` | `buildcover-<slug>` |
| `site` | `Site.BUILDCOVER` |
| `title` | `career.title` |
| `companyName` | `Cover` (constant) |
| `companyUrl` | `https://buildcover.com/careers/` |
| `jobUrl` | `https://buildcover.com/careers/<slug>/` |
| `location` | `career.location` via shared `parseLocationList` (`on-site` token stripped; remote/hybrid handled by the parser) |
| `isRemote` | remote/hybrid mention on the location; `null` when absent |
| `employmentType` | raw `career.type` (e.g. `Full-Time`, `Temp to hire`) |
| `jobType` | `getJobTypeFromString(type)` when it maps, else omitted |
| `description` | Portable Text of `overview` → `role` → `experience` → `extraSections` (each under the site's own section label: `Overview` / `Role` / `Experience` / the section `title`) → `Compensation` |
| `compensation` | best-effort salary parse of the `compensation` text (has real ranges, e.g. `$35.00/hr – $40.00/hr`); the per-unit token (`/hr`, `/yr`, …) is passed to the shared parser as an explicit interval (`ExtractSalaryOptions.interval`) so the pay period is authoritative, not guessed from magnitude |
| `datePosted` | `career._createdAt` → local day (`toDateOnly`) |
| `emails` / `applyUrl` | `careersPage.contactEmail` (else emails in the body); `applyUrl = mailto:<first>` |

## Non-goals

- A shared/parameterized "Sanity careers" plugin (schemas are per-project bespoke).
- Compensation beyond the shared best-effort text parse.
- Scraping the Nuxt HTML (client-hydrated; the Sanity API is the source of truth).

## Acceptance

- Live `buildcover.com` yields the current open roles (6 at authoring time) with
  title, location, employment type, full description, `join@buildcover.com`
  apply, best-effort compensation, and a `datePosted`.
- Unit tests (mocked GROQ response) cover role mapping, Portable-Text rendering
  (headings/bullets, section labels), location parsing, compensation parse,
  the global apply email, the empty/no-roles path, and input filters.
- Registered in the four standard places (Site enum, `ALL_SOURCE_MODULES`,
  tsconfig paths, jest moduleNameMapper); `api` build + plugin tests green.
