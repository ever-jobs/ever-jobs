# Spec: 5066 — source-company-vight

| Field | Value |
| --- | --- |
| Spec ID | 5066 |
| Slug | source-company-vight |
| Status | implemented |
| Plugin | `packages/plugins/source-company-vight` |
| Category | `company` (single company — Vight / vightaero.com) |
| Related specs | 5061 (Hylio — two-step listing/detail); 5063 (Framework — two-step listing/detail); 5062/5064/5065 (prior company careers plugins) |

## Problem

Vight (`vightaero.com`, "two-seat VTOL aircraft for private point-to-point flight") hosts its careers page as a **hand-coded static site** (no CMS/framework/ATS). `/join-us/` lists open roles as `<article class="role">` cards; each real role's card links to an on-domain `/join-us/{slug}/` **detail page** carrying the full JD. Applying is by email — every apply link (cards and detail pages) is a **Cloudflare email-protected** `/cdn-cgi/l/email-protection#<hex>` anchor that decodes to `join@vightaero.com`; the address is never present as plaintext. No adapter existed, so these openings were not ingested.

Like Hylio (5061) / Framework (5063), the full JD lives on the employer's own domain, so this is a two-step careers scraper — plain HTTP + Cheerio, no headless browser.

## Approach

Plain-HTTP fetch (no headless — the site is fully server-rendered static HTML). Two steps, both on `vightaero.com`:

1. **GET `/join-us/`** — enumerate each `<article class="role">` card. Per card: the stable `id` attribute (the slug), the title (`.role-title`), the one-line copy (`.role-copy`), the meta chips (`.role-meta span`), and the apply link. A card whose apply link is an on-domain path links to a `/join-us/{slug}/` detail page; a card whose apply link is a Cloudflare email-protected anchor (the "Exceptional Generalist") is emitted from the card alone.
2. **GET `/join-us/{slug}/`** (bounded fan-out via `Promise.allSettled`, real roles only) — parse:
    - title — the detail `<h1>` (can differ from the card, e.g. GNC card `Founding GNC Engineer` → detail `Founding GNC and Flight Software Engineer`); the detail title wins
    - meta — the `.meta` line `SF Bay Area, CA · Full time · On site` split on `·`
    - description — every `<section>` (About Vight / Role / What You Will Do / You Might Be A Fit If You / Nice To Have / What We Offer) in document order → markdown
    - apply email — the Cloudflare-protected apply link decoded to `join@vightaero.com`

Meta chips (card or detail) are classified by shape, not position: a `City, ST` chip is the location; the first chip that resolves to a known job type is the employment type; other chips (`On site`, `Exceptional fit`, `Conversation first`) are ignored — so the generalist yields neither location nor type.

## Scope

- New single-company plugin `source-company-vight` (`category: 'company'`).
- Map each role to `JobPostDto`:
    - `id` — `vight-<slug>` (the site's own card `id`: `vight-gnc`, `vight-propulsion`, `vight-chief-engineer`, `vight-exceptional-generalist`)
    - `title` — the detail `<h1>` (card title fallback / generalist uses the card title)
    - `companyName` — `Vight`; `companyUrl` — `/join-us/`
    - `jobUrl` — the on-domain `/join-us/{slug}/` detail page (canonical); the generalist has no detail page, so it falls back to `/join-us/`
    - `location` — `SF Bay Area, CA` → city `SF Bay Area` / state `CA` via `parseLocationList` (real roles only; generalist has none)
    - `employmentType` / `jobType` — `Full time` → `FULL_TIME` via `getJobTypeFromString` (real roles; generalist has none)
    - `description` — the detail JD sections (incl. the `About Vight` boilerplate) → markdown; the generalist uses its card copy
    - `isRemote` — `false` (the site states `On site`)
    - `emails` — `[join@vightaero.com]` (decoded from the Cloudflare-protected apply link)
    - `applyUrl` — unset; `compensation` / `datePosted` — none stated

## Non-goals

- **No `mailto:` in `applyUrl`.** Applying is by email; the address is carried on `emails` and `applyUrl` is left unset (a `mailto:` is not a web URL). (No independent precedent for a `mailto:` `applyUrl`.)
- **No off-domain fetch.** Nothing off `vightaero.com` is fetched (the test seam fails if any off-domain URL is requested). No ATS, no Indeed, no job board.
- **No fabricated fields.** `compensation` / `datePosted` left empty (none stated); the generalist's location / employment type stay null (its meta carries neither); `isRemote` is `false` (stated `On site`, not synthesized).
- **No headless browser.** The site is static server-rendered HTML.

## Contracts

- Implements `IScraper` via the `@SourcePlugin` decorator (`Site.VIGHT`).
- HTTP goes through the shared `@ever-jobs/common` client; description via `markdownConverter`; location via `parseLocationList`; job type via `getJobTypeFromString`.
- `Logger` (not `console.log`); a per-role detail failure degrades to the card-only fields (card title, card location/type, on-domain `jobUrl`, card copy as description); a top-level fetch/parse failure returns an empty `JobResponseDto` (no throw).
- The apply email is Cloudflare-obfuscated; the plugin decodes the `/cdn-cgi/l/email-protection#<hex>` token (first byte = XOR key) and strips the trailing `?subject=`. If the token is malformed the email degrades to `[]` while the rest of the role still populates.

## Test plan

Fixture-based unit tests over the captured `/join-us/` listing + three `/join-us/{slug}/` detail pages (the detail fetch seam throws if any non-`vightaero.com` URL is requested, proving nothing off-domain is fetched):

- module resolves through NestJS DI; `Site.VIGHT === 'vight'`
- 3 real roles + the generalist enumerated (4), unique `vight-<slug>` ids; every role `applyUrl` unset, `emails=[join@vightaero.com]`, not an Indeed/LinkedIn URL, no compensation, null datePosted
- detail wins: GNC title `Founding GNC and Flight Software Engineer`; `jobUrl` the on-domain `/join-us/{slug}/`; `SF Bay Area` city / `CA` state; `Full time` → `FULL_TIME`
- all detail JD sections (incl. `About Vight`) carried into the description as markdown
- generalist kept from the card alone: card title, `/join-us/` jobUrl, null location/type, card-copy description, `join@vightaero.com`
- graceful degradation when a detail page cannot be fetched (role still emits from the card: card title/location/type + on-domain jobUrl, card copy description)
- input filters (searchTerm, offset, resultsWanted); a listing with no role cards returns nothing (no throw)
