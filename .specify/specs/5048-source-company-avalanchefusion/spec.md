# Spec: 5048 — source-company-avalanchefusion

| Field | Value |
| --- | --- |
| Spec ID | 5048 |
| Slug | source-company-avalanchefusion |
| Status | implemented |
| Plugin | `packages/plugins/source-company-avalanchefusion` |
| Category | `company` (single company — Avalanche Energy / avalanchefusion.com) |
| Related specs | 5042, 5045, 5046, 5047 (prior company careers plugins); 5045 (shared salary `interval` hint) |

## Problem

Avalanche Energy (`avalanchefusion.com`) hosts its careers site on **Webflow** with **no ATS**. Open roles are Webflow CMS collection pages: a board at `/careers/open-positions` links to one detail page per role at `/careers/open-position/{slug}`. The pages are **server-rendered plain HTML** (HTTP 200, no Cloudflare, no JS challenge). No adapter existed, so these openings were not ingested.

Two site-specific properties shape the mapping:

- **Structured pay.** Every role publishes a `Salary Range` block with an explicit per-unit token — e.g. `$135K/yr - $175K/yr`. The interval is authoritative from the token, not inferred from magnitude.
- **Apply goes to LinkedIn.** Each role's "Apply" button links to a LinkedIn job posting (`linkedin.com/jobs/view/{id}`) — not an ATS host, not an on-site form, not an email.

## Approach

Plain-HTTP, two-level scrape (no headless browser):

1. **Board:** GET `/careers/open-positions`, collect every `/careers/open-position/{slug}` anchor, dedupe by slug; the anchor text is the role title.
2. **Detail (per role, bounded fan-out via `Promise.allSettled`):** GET each role page and Cheerio-parse:
    - title — `h2.blue.center-text` (falls back to the listing title)
    - salary — the `.salary-range` block text
    - description — the `.w-richtext` body, rendered to markdown via the shared `markdownConverter`
    - apply URL — the `Apply` anchor's `href` (a LinkedIn job posting)

A role whose detail page fails to fetch still appears, populated from the board (title, jobUrl) plus the company-location default.

## Scope — one company plugin, NOT a shared plugin

This is a **single-company** plugin (like the prior company careers plugins, Specs 5042/5045/5046/5047): the domain, URLs, and company name are baked into constants; `companySlug` is ignored; `category:'company'`. Webflow is uniform only in *transport* (server-rendered collection pages), not *schema* — the `Salary Range` block and page layout are this site's own design, so there is no shared contract to parameterize by an id.

### Field mapping

| JobPostDto field | Source |
| --- | --- |
| `id` | `avalanchefusion-<slug>` (stable, unique per role) |
| `site` | `Site.AVALANCHEFUSION` |
| `title` | board anchor text (falls back to the detail `h2`) |
| `companyName` | `Avalanche Energy` (constant; the brand, not the domain) |
| `companyUrl` | `https://www.avalanchefusion.com/careers` |
| `jobUrl` | the role's `/careers/open-position/{slug}` page |
| `location` | company-metro default `Seattle, WA` via shared `parseLocationList` |
| `isRemote` | remote mention on the default location (`false`) |
| `description` | `.w-richtext` body rendered to markdown |
| `compensation` | `Salary Range` block with the interval taken from its own token |
| `datePosted` | `null` (the Webflow pages carry no posting date) |
| `emails` | `[]` (apply is a LinkedIn URL, not an email) |
| `applyUrl` | the role's LinkedIn job posting |

### Per-role pay interval

The pay range carries an explicit per-unit token (all current roles are `/yr`; the token is read rather than assumed so an hourly role would still be correct). The interval is read from the token and passed as the authoritative `interval` to the shared salary parser (`ExtractSalaryOptions.interval`, Spec 5045), so the amount's magnitude never has to guess the period. The token is stripped from the *numeric* input first so the range regex can span it (`$135K/yr - $175K/yr` → `$135K - $175K` parsed as yearly), with its meaning carried as the interval; `K`/`M` magnitude suffixes and unicode dashes are handled.

### Location

Roles carry **no structured location**. The company is in the Seattle, WA metro (its sites are in Tukwila, WA), so every role defaults to `Seattle, WA`. A couple of role bodies mention a site in free prose, but that prose is noisy and inconsistent (concatenated tokens, multiple cities), so it is **not** parsed into the location — a clean, consistent company-metro default is preferred over an occasionally-mangled per-role guess.

## Non-goals

- A shared/parameterized Webflow careers plugin (this site's markup is bespoke).
- `employmentType` / `jobType` — not structured on the site, and prose inference misfires (e.g. "subcontract" → "Contract"), so it is omitted rather than guessed.
- Per-role `datePosted` (not present on the Webflow pages).
- Resolving the LinkedIn posting itself (the apply URL is emitted as-is).

## Testing

- **Unit (fixture-based, no network):** the board fetch and detail fetch are isolated behind two protected seams so tests substitute captured ground truth (the real board HTML + three real detail pages). Tests cover: all nine roles parsed with a LinkedIn apply URL and no email; structured `Salary Range` → yearly compensation with the correct amounts; the rich-text body carried into the description as markdown; the company-location default; graceful degradation when a detail page fails to fetch; input filters; and the empty-board path.
- **Live path:** both the board and detail pages are open, so the full parse → detail fetch → salary/apply pipeline is exercised against the real nine roles.

## Acceptance

- The nine current roles are produced with title, jobUrl, description, a yearly compensation range, and a LinkedIn apply URL.
- Registered in the four standard places (Site enum, `ALL_SOURCE_MODULES`, tsconfig paths, jest moduleNameMapper); `api` build + plugin tests green.
