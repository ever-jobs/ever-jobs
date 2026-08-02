# Spec: 5044 — source-notion

| Field | Value |
| --- | --- |
| Spec ID | 5044 |
| Slug | source-notion |
| Status | implemented |
| Plugin | `packages/plugins/source-notion` |
| Category | `company` (shared, page-id keyed — one plugin serves every Notion board) |
| Related specs | 5042 (Terraform Industries company careers), 5023 (Work at a Startup) |

## Problem

Some companies host their careers page directly on a public **Notion** site
(`*.notion.site`) with no ATS behind it — the roles are Notion sub-pages and the
only way to apply is an email address in the body. Stone Power
(`fossil-surfboard-e82.notion.site/Careers-at-Stone-Power-361cc3fe052a81098df8d9d81147636d`)
is the first such tenant: 6 roles, apply by emailing `careers@stonepower.us`,
no Greenhouse/Lever/etc. anywhere.

There was no adapter for Notion-hosted boards, so these companies were not
ingested at all.

## Key insight — one shared plugin, keyed by page id

Every public Notion page exposes the same unauthenticated JSON API:

```
POST https://www.notion.so/api/v3/loadPageChunk
body: { page: { id: <dashed-uuid> }, limit, cursor: { stack: [] }, chunkNumber: 0, verticalColumns: false }
→ { recordMap: { block: { <blockId>: { role, value: { id, type, properties, content, created_time } } } } }
```

The API works with the **page id alone** (no subdomain needed — verified live).
So Notion is wired like an ATS (Greenhouse/Workable): a single `Site.NOTION`
plugin invoked with a per-tenant key, **not** one plugin per company and **no**
`if company x … elif company y` branching. The tenant key
(`id_at_job_host`) is the 32-hex Notion page id; a full `companyUrl` is also
accepted and the id is extracted from it.

## Scope

New plugin `source-notion` that, given a Notion page id (via `companySlug` or
`companyUrl`):

```
loadPageChunk(rootPageId)
  → root.content = [ intro text, "Current Openings" heading, role page, role page, … ]
  → keep child blocks of type "page"  (each is a role; title is inlined in the chunk)

for each role page (bounded fan-out, concurrency 5):
  loadPageChunk(roleId)
    → walk role.content blocks in order:
        - drop the leading header that merely repeats the page title
        - capture the labelled "Location: …" line
        - render every text block into a markdown-ish description
    → created_time → datePosted; emails in the body → apply mailto
```

This is **child-page mode**. A Notion board can instead be a database/collection
view (roles as rows with Location/Type properties). That is a separate, not-yet
-built mode (YAGNI — Stone Power and the current cohort are all child-page). The
plugin detects "no child-page roles" and returns empty with a warning rather
than silently mis-parsing, so a real collection-view tenant is visible.

### Field mapping

| JobPostDto field | Source |
| --- | --- |
| `id` | `notion-<dashless roleId>` |
| `site` | `Site.NOTION` |
| `title` | role page `properties.title` |
| `companyName` | root title, `Careers at X` → `X` (falls back to the slug) |
| `jobUrl` | `https://{subdomain}.notion.site/{dashless roleId}` (or `www.notion.so` when no subdomain is known) |
| `location` | parsed from the `Location:` line (`on-site` token stripped; remote/hybrid handled by the shared parser) |
| `isRemote` | remote/hybrid mention on the `Location:` line; `null` when there is no location line |
| `description` | role blocks concatenated (headers → `##`/`###`, list items → `- `), title-duplicating header dropped |
| `compensation` | best-effort salary parse from the body (usually absent — comp is prose) |
| `datePosted` | role page `created_time` → local day (`toDateOnly`) |
| `emails` / `applyUrl` | emails extracted from the body; `applyUrl = mailto:<first>` |

## Non-goals

- Collection/database-view boards (added only when a real tenant needs it).
- Per-company branching or hardcoded company constants.
- Compensation beyond the shared best-effort text parse (Notion has no
  structured salary field).

## Acceptance

- Live Stone Power page yields **6 roles** with title, `Los Angeles, CA`
  location (no `On-Site` leak), full description, `careers@stonepower.us` apply,
  and a `datePosted`.
- Unit tests (mocked `loadPageChunk`) cover child-page enumeration, block/field
  parsing, both record envelopes, id extraction from slug/URL, the empty/no-role
  path, and input filters.
- Registered in the four standard places (Site enum, `ALL_SOURCE_MODULES`,
  tsconfig paths, jest moduleNameMapper); `api` build + plugin tests green.
