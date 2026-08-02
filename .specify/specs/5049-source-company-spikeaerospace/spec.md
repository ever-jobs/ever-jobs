# Spec: 5049 — source-company-spikeaerospace

| Field | Value |
| --- | --- |
| Spec ID | 5049 |
| Slug | source-company-spikeaerospace |
| Status | implemented |
| Plugin | `packages/plugins/source-company-spikeaerospace` |
| Category | `company` (single company — Spike Aerospace / spikeaerospace.com) |
| Related specs | 5024 (`toDateOnly` local-day); 5042/5045/5046/5047/5048 (prior company careers plugins) |

## Problem

Spike Aerospace (`spikeaerospace.com`) hosts its careers site on **WordPress (Elementor)** with **no ATS**. Each open role is a WordPress **post** filed under the **"Current Openings" category**; applying is an on-page form (no external board, no `mailto:`, no per-role apply URL). No adapter existed, so these openings were not ingested.

The role set is only reliably available from the category, not the visible page:

- The `/current-openings/` page is an Elementor **Loop Grid** that server-renders only the first few roles and reveals the rest via a "Load More" (AJAX) — so scraping that page's HTML under-counts.
- The canonical set is the WordPress category **"Current Openings"** (`count: 9`). Some roles also have duplicate WordPress *page* copies, and one role exists only as a *post*, so enumerating pages is both over- and under-inclusive.

## Approach

Plain-HTTP WordPress REST, no headless browser:

1. **Resolve the category id** by slug: GET `/wp-json/wp/v2/categories?slug=current-openings` → id (fall back to the known id if the lookup returns nothing).
2. **Fetch the role posts:** GET `/wp-json/wp/v2/posts?categories=<id>&per_page=100` → each post's `title`, `content.rendered`, `link`, and `date`.
3. **Map each post** to a `JobPostDto`.

The category is the authoritative enumerator: it returns exactly the open roles regardless of the Loop-Grid pagination, and it self-heals as roles are added/removed.

## Scope — one company plugin, NOT a shared plugin

This is a **single-company** plugin (like the prior company careers plugins): the WordPress host and category slug are baked into constants; `companySlug` is ignored; `category:'company'`. WordPress's REST transport is uniform across sites, but the per-site content model is bespoke, so there is no shared "WordPress" job schema to parameterize by an id.

### Field mapping

| JobPostDto field | Source |
| --- | --- |
| `id` | `spikeaerospace-<post-slug>` (stable, unique per role) |
| `site` | `Site.SPIKEAEROSPACE` |
| `title` | post `title.rendered`, HTML-entity-decoded, leading `Seeking ` verb removed |
| `companyName` | `Spike Aerospace` (constant; the brand, not the domain) |
| `companyUrl` | `https://www.spikeaerospace.com/careers/` |
| `jobUrl` | the post `link` (its own page URL) |
| `location` | `null` (the site lists no location for any role) |
| `description` | `content.rendered` rendered to markdown, with the form artifacts removed |
| `datePosted` | post `date` (publish) via shared `toDateOnly` |
| `emails` | `[]` (apply is an on-page form, not an email) |
| `compensation` | omitted (no pay on the site) |

### datePosted

Each post carries a publish `date`; it is passed through the shared `toDateOnly` converter (Spec 5024, local-day) to `datePosted`. The publish `date` is used, not `modified` — `modified` reflects later bulk edits and would misrepresent the posting age.

### Description cleanup

The résumé form is injected client-side, so `content.rendered` contains only prose plus a `wpcf7` "Contact form not found" placeholder and a dangling "Submit Your Resume:" label. Both are removed before the markdown conversion; the role prose (intro, Responsibilities, Qualifications, How to Apply, EEO statement) is kept.

### Title

Post titles carry the site's listing phrasing (e.g. `Seeking Aircraft Configuration Engineer`, `Senior Stability &#038; Controls Engineer`). Titles are HTML-entity-decoded, and a leading `Seeking ` verb — which is never part of the role — is dropped. Seniority words (`Senior`, `Experienced`) are preserved.

### Location

Roles carry **no structured location** and the site publishes no address, phone, or email, so `location` is left `null` rather than assert a value the site does not state.

## Non-goals

- A shared/parameterized WordPress careers plugin (this site's content model is bespoke).
- Compensation (not present anywhere on the site).
- `employmentType` / `jobType` (not structured on the site).
- Scraping the `/current-openings/` Loop Grid or its "Load More" AJAX (the category is the authoritative enumerator).

## Testing

- **Unit (fixture-based, no network):** the REST fetch is isolated behind one protected seam so tests substitute captured ground truth (the real category posts). Tests cover: all nine roles mapped with no email; roles that exist only as posts (not linked from the listing) are included; `datePosted` from the publish date as a calendar day; title decoding + `Seeking` removal; description carried as markdown with the form artifacts stripped; `location` left `null`; input filters; and the empty-category path.
- **Live path:** the REST endpoints are open, so the full resolve-category → fetch-posts → map pipeline is exercised against the real nine roles.

## Acceptance

- The nine current roles are produced with title, jobUrl, description, and a truthful `datePosted`; `location` is `null` (the site states none).
- Registered in the four standard places (Site enum, `ALL_SOURCE_MODULES`, tsconfig paths, jest moduleNameMapper); `api` build + plugin tests green.
