# Spec: 5046 — source-company-nanonuclearenergy

| Field | Value |
| --- | --- |
| Spec ID | 5046 |
| Slug | source-company-nanonuclearenergy |
| Status | implemented |
| Plugin | `packages/plugins/source-company-nanonuclearenergy` |
| Category | `company` (single company — NANO Nuclear Energy / nanonuclearenergy.com) |
| Related specs | 5042 (Terraform Industries company careers), 5045 (Cover / Sanity company careers) |

## Problem

NANO Nuclear Energy (`nanonuclearenergy.com`, NASDAQ: NNE) hosts its careers page
on **WordPress + the Divi page builder** with **no ATS** behind it — the roles
are hand-authored Divi "blurb" modules and the only way to apply is an on-page
WordPress (WPForms) modal form. There is no external job board, no `mailto:`, and
no per-role apply URL. No adapter existed, so NANO's openings were not ingested.

## Key insight — read the WordPress REST API, not the rendered HTML

WordPress exposes the page's server-rendered markup as structured JSON via its
REST API, so the content comes back without a headless browser:

```
GET https://nanonuclearenergy.com/wp-json/wp/v2/pages?slug=careers
```

The response is a one-element array whose `content.rendered` holds the full Divi
markup. The roles are parsed out of that markup with Cheerio.

### Divi role structure (consistent across all roles)

Each role is a run of sibling Divi modules:

- a title **blurb** — an `h4.et_pb_module_header` (the role title) + an optional
  `et_pb_blurb_description` subtitle (e.g. `Reactor Physics`)
- a **text** module (`et_pb_text_inner`) — the description body
- three meta **blurbs** — `Full Time`, `Location - Oak Brook, IL`, `Salary: $min - $max`

Parsing walks the `.et_pb_blurb, .et_pb_text` modules in document order: a blurb
carrying an `h4` opens a new role, the following text module is its body, and the
label-prefixed blurbs fill its meta.

## Scope — one company plugin, NOT a shared "WordPress" ATS

This is a **single-company** plugin (like `source-company-terraformindustries`
and `source-company-buildcover`): the WordPress host and page slug are baked into
constants; `companySlug` is ignored; `category:'company'`.

Deliberately **not** wired like Notion/Greenhouse (one shared, parameterized
plugin). WordPress's REST *transport* is uniform across sites, but the per-site
content model is bespoke: NANO uses hand-authored Divi blurbs; another WordPress
company could use the WP Job Manager plugin, a custom post type, or a different
builder entirely. There is no shared WordPress job schema to parameterize by an
id. (If a cohort of **WP Job Manager** sites appears — those *do* expose a
uniform `/wp-json/wp/v2/job-listings` schema — a shared `source-wpjobmanager`
plugin would be justified then. YAGNI until then.)

### Field mapping

| JobPostDto field | Source |
| --- | --- |
| `id` | `nanonuclearenergy-<slug>` (slug folds in the subtitle so repeated titles stay distinct) |
| `site` | `Site.NANONUCLEARENERGY` |
| `title` | role `h4` heading |
| `companyName` | `NANO Nuclear Energy` (constant) |
| `companyUrl` | `https://nanonuclearenergy.com/careers/` |
| `jobUrl` | `https://nanonuclearenergy.com/careers/` (no per-role URL exists on the page) |
| `location` | `Location - …` blurb via shared `parseLocationList` |
| `isRemote` | remote/hybrid mention on the location; `null` when absent |
| `employmentType` | `Full Time` blurb (raw) |
| `jobType` | `getJobTypeFromString(employmentType)` when it maps, else omitted |
| `description` | subtitle (bolded) + body text module, rendered to markdown via shared `markdownConverter` |
| `compensation` | `Salary: …` blurb — all roles state an **annual** base, so the interval is passed as an explicit `CompensationInterval.YEARLY` hint (`ExtractSalaryOptions.interval`) rather than guessed from magnitude |
| `datePosted` | `null` (the page carries no posting date) |
| `emails` | any address found in the body (usually none — apply is an on-site form) |

### Salary normalization (Word-paste artifacts)

The pay prose is authored in Word and pasted, so the numbers carry artifacts that
break a naive parse. Before parsing, the salary text is repaired:

- strip the `Salary:` label; normalize unicode dashes → `-`
- close a gap after the currency symbol (`$ 130,000` → `$130,000`)
- close gaps inside a number group (`$1 48 ,000` → `$148,000`)
- rebuild `"$min - $max"` from the first two numeric groups so a `$` is present
  on both ends (`99,000 - $131,000` → `$99,000 - $131,000`)

## Non-goals

- A shared/parameterized "WordPress careers" plugin (per-site schemas are bespoke).
- Submitting or modeling the on-site WPForms application flow.
- Per-role `jobUrl` / `datePosted` (neither exists on the page).

## Acceptance

- Live `nanonuclearenergy.com` yields the current open roles (14 at authoring
  time) with title, location, employment type, full description, and a yearly
  compensation range — including the roles whose pay text carries Word-paste
  artifacts.
- Unit tests (mocked WP REST response) cover role parsing, repeated-title id
  disambiguation, clean and artifact-laden salary repair (yearly interval),
  body email extraction, the empty/no-roles and request-failure paths, and input
  filters.
- Registered in the four standard places (Site enum, `ALL_SOURCE_MODULES`,
  tsconfig paths, jest moduleNameMapper); `api` build + plugin tests green.
