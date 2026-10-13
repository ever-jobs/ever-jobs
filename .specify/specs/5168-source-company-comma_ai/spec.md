# Spec 5168 — `source-company-comma_ai`

## Problem

comma.ai publishes its careers page (`https://comma.ai/jobs`) as a Svelte
site. The full job list — title, team, location, description, qualifications,
and how-to-apply — is bundled as a plain JS array inside the page's node
chunk (`/_app/immutable/nodes/{id}.{hash}.js`). The visible accordion detail
is rendered client-side on expand, but every field it renders is already in
the bundle, so no browser is required.

The board currently has no plugin; callers see "needs company plugin".

## Scope

- New source plugin `source-company-comma_ai` (`Site.COMMA_AI = 'comma_ai'`,
  `companyDomains: ['comma.ai']`).
- Fetch `https://comma.ai/jobs` (or `input.companyUrl`), extract every
  `/_app/immutable/nodes/*.js` URL, fetch each until one contains the jobs
  array anchor `=[{title:"`.
- Parse the array with a balanced-slice, never `eval` — entries look like
  `{title:"…",team:"…",location:"…",description:`…`,qualifications:[…],
  howToApply:'…'}`. `description` is a **template literal** (backticks) and
  `team` may be absent on some entries (e.g. "Internships / Co-op").
- Emit `JobPostDto`s:
  - `id` = `comma_ai-{slug}`, `atsId` = `slug`, `site` = `Site.COMMA_AI`,
    `atsType` = `comma_ai`
  - `slug` = kebab-case of `title` — the site's own anchor ids follow this
    rule (`Video Content Creator` → `video-content-creator`,
    `Internships / Co-op` → `internships-co-op`,
    `CNC Machinist / Head of Prototyping` → `cnc-machinist-head-of-prototyping`)
  - `title` ← `title`; `department` ← `team` when present
  - `location` ← `location` minus the leading `On-site in ` /
    `Paid and on-site in ` prefix, parsed via `parseLocationText`
    (`San Diego, CA` → city/state); remote stays false for on-site roles
  - `description` ← `description` HTML + `Qualifications:` list +
    `howToApply` HTML
  - `jobUrl` / `jobUrlDirect` / `applyUrl` ←
    `https://comma.ai/jobs#{slug}` — the site's own share/copy-link anchor;
    the apply CTA is a `mailto:work@comma.ai` whose text stays in `description`
  - `companyName` = `comma`, `companyUrl` = `https://comma.ai`
- `scrape()` filters by `searchTerm`/`location`/`offset`/`resultsWanted`
  (same convention as other company plugins), returns
  `JobResponseDto` with `ScrapeDiagnostics('empty', …)` when no jobs parse.

## Non-goals

- Browser/Playwright rendering — the accordion detail is in the bundle.
- Following the `/leaderboard` content-challenge link or sending email.
- Guaranteeing a stable chunk filename — hashed names rotate per deploy;
  the plugin resolves them from the page each run.

## Contracts

- Input: `ScraperInputDto` — only `companyUrl`, `proxies`, `caCert`,
  `requestTimeout`, `searchTerm`, `location`, `offset`, `resultsWanted`
  are read.
- Output: `JobResponseDto` of `JobPostDto` (shape above), or
  `diagnostics.reason = 'empty'`.

## Test plan

- Fixture: the careers HTML + the real node chunk (10 jobs).
- The full scrape returns 10 `JobPostDto`s, ordered as in the chunk.
- Field mapping: `id`/`atsId`/`slug` derivation (incl. `/` in titles),
  `department` present vs absent, `San Diego, CA` → city + state,
  `applyUrl` = `jobs#{slug}` anchor.
- `description` contains the bundle `description`, the `Qualifications:`
  list, and the `howToApply` HTML.
- No matching chunk → empty result + `empty` diagnostics.
