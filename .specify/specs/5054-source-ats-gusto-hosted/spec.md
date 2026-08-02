# Spec: 5054 — source-ats-gusto-hosted

| Field | Value |
| --- | --- |
| Spec ID | 5054 |
| Slug | source-ats-gusto-hosted |
| Status | implemented |
| Plugin | `packages/plugins/source-ats-gusto-hosted` |
| Related specs | 5022 (shared JSON-LD extraction), 5040 (jobvite board + detail JSON-LD), 5041 (prismhr board + detail hybrid), 5047 (desktopmetal BrowserPool stealth / Cloudflare precedent) |

## Problem

There was no adapter for the **Gusto-hosted** job-board product. Gusto (the
payroll/HR vendor) hosts multi-tenant boards at
`https://jobs.gusto.com/boards/<slug>` for other companies, where the board slug
is `<company>-<uuid>` (e.g.
`material-hybrid-manufacturing-inc-ed3a1ae2-…`).

This is a **different target** from the existing `source-company-gusto` plugin.
That plugin scrapes Gusto, Inc.'s OWN corporate careers — a single employer,
backed by a hardcoded Greenhouse board (`api.greenhouse.io/v1/boards/gusto`) —
and correctly ignores any tenant slug. It was never a multi-tenant board reader.

The upstream harvesting pipeline detected `jobs.gusto.com/boards/<slug>` correctly
as the Gusto-hosted board product but labelled it with the host token `gusto`,
which collided with `Site.GUSTO` (the employer). Every hosted tenant therefore
routed to `source-company-gusto` and harvested Gusto, Inc.'s own ~79 postings —
attributing them to the tenant (`companyName = "Gusto"`, all URLs
`job-boards.greenhouse.io/gusto/...`). Two unrelated tenants (`material.inc`,
`naturaresources.com`) returned an **identical** job set.

The fix is two-part (this spec is the ever-jobs half):

- **ever-jobs**: a real per-tenant ATS plugin `source-ats-gusto-hosted`
  (`Site.GUSTO_HOSTED = 'gusto_hosted'`, category `ats`) that consumes the tenant
  slug and scrapes that tenant's own board. `source-company-gusto` is left
  untouched.
- **upstream pipeline** (out of scope here): relabel the host token
  `gusto → gusto_hosted` so boards route to this plugin, never the employer one.

## Scope

New plugin `source-ats-gusto-hosted` that reads a tenant board for enumeration,
then fans out to each posting detail page for enrichment — the board + detail
hybrid of Specs 5040 / 5041, but browser-fetched like Spec 5047:

```
GET /boards/{slug}
  → parseBoard: every <a href="/postings/{postingSlug}"> → {postingSlug, title, jobUrl}
  → de-dupe by postingSlug

GET /postings/{postingSlug}   (bounded fan-out, one per role)
  → parseJobPostingLd(html)[0]   (shared extractor, Spec 5022)
    → title, description, datePosted, employmentType, hiringOrganization,
      structured location, remote, baseSalary
```

Both pages sit behind a **Cloudflare managed challenge** (a plain HTTP GET is
403'd `cf-mitigated: challenge`), so they are loaded with the shared stealth
headless browser (`BrowserPool.getPage({ proxy, stealth: true })`) — the same
approach as `source-company-desktopmetal` (Spec 5047). The fetch methods are
isolated (protected seams) so unit tests substitute captured HTML with no
browser.

### Field mapping

| JobPostDto field | Source |
| --- | --- |
| `atsId` | posting slug (path token after `/postings/`) |
| `id` | `gusto-hosted-{postingSlug}` |
| `atsType` | `gusto-hosted` |
| `site` | `Site.GUSTO_HOSTED` |
| `title` | detail JSON-LD `title`, board anchor text fallback |
| `companyName` | detail JSON-LD `hiringOrganization`, de-slugified tenant (minus UUID) fallback |
| `jobUrl` / `applyUrl` | `https://jobs.gusto.com/postings/{postingSlug}` |
| `location` | detail JSON-LD `jobLocation` (city/region/country); bare `Remote` marker when remote-only |
| `isRemote` | detail JSON-LD `jobLocationType == TELECOMMUTE`, title text fallback |
| `employmentType` | detail JSON-LD `employmentType` (raw, e.g. `FULL_TIME`) |
| `jobType` | `getJobTypeFromString(employmentType)` (underscores → spaces first) |
| `datePosted` | detail JSON-LD `datePosted` (ISO → `YYYY-MM-DD` via `toDateOnly`) |
| `description` | detail JSON-LD `description` (formatted per `descriptionFormat`) |
| `compensation` | detail JSON-LD `baseSalary` via `jobPostingLdToCompensation` |
| `emails` | extracted from the description body |

### Non-goals

- **Not** a change to `source-company-gusto` — Gusto, Inc.'s employer plugin
  stays exactly as-is.
- **No** Greenhouse token recovery. The Gusto board slug is not a Greenhouse
  board token (`boards-api.greenhouse.io/v1/boards/<slug>/jobs` → 404); the fix
  harvests `jobs.gusto.com` directly rather than chasing a backing ATS.
- **No** guarantee the Cloudflare challenge always clears from a datacenter IP.
  When it does not, the board yields no postings and the scrape returns `[]` —
  it must NEVER fall back to another company's board (the original bug).
- **No** search/location server-side filtering — Gusto boards are per-tenant and
  small; enumeration is capped by `resultsWanted`.

## Contracts

### Tenant resolution

- `companySlug` = the board slug (`<company>-<uuid>`), or a full
  `https://jobs.gusto.com/boards/<slug>` URL.
- `companyUrl` = any `https://jobs.gusto.com/boards/<slug>` URL — the path
  segment after `boards` is the slug.
- No slug/url resolvable → `[]` (no fetch issued).
- **Slug-consumption contract (the correctness fix):** the board URL embeds the
  slug, so two different slugs MUST produce two different boards / job sets. This
  is exactly what `source-company-gusto` failed to do.

### Board parse

- Every `<a href>` matching `/postings/{postingSlug}` (absolute or relative;
  trailing `/applicants/new` etc. stripped) → a list item.
- De-duped by posting slug (first occurrence wins).
- Anchor text is the title fallback; detail JSON-LD `title` wins.

### Detail parse

- Shared `parseJobPostingLd` extractor (Spec 5022) supplies every detail field.
- A missing/failed detail page still emits the role from board fields (title from
  the anchor, company from the de-slugified tenant), with detail-only fields
  null.

### Graceful degradation & safety

- Cloudflare challenge not cleared / empty / malformed board → `[]`.
- Per-role detail fan-out is bounded (`Promise.allSettled`, concurrency cap) so
  one slow/failed page never nukes the batch.
- All logging via NestJS `Logger`; no `console.log`; no secrets logged.
- `BrowserPool.close()` on module destroy.

## Test plan

### Unit tests (protected fetch seams stubbed; no browser)

- Board posting + detail JSON-LD → full `JobPostDto` (all fields incl.
  compensation, jobType, emails, date).
- **Slug consumption**: two different slugs yield two different boards/job sets
  with different company names.
- Board with no postings → `[]`.
- Malformed board HTML → `[]`.
- Detail page fails → role still emitted from board fields (company falls back to
  de-slugified tenant; description null).
- De-dupe a posting linked twice (incl. an `/applicants/new` variant).
- `/applicants/new` suffix stripped from the posting slug / job URL.
- `resultsWanted` cap.
- Remote detected from the title when JSON-LD is silent (bare `Remote` location).
- JSON-LD `hiringOrganization` preferred over the derived tenant name.
- No slug/url → `[]` and no fetch issued.
- Slug resolved from a `companyUrl`.
- Description formatting (HTML / plain).

### Live validation (deferred — Cloudflare)

- The board/posting HTML shape could not be captured from the Devin VM: the
  Cloudflare Turnstile managed challenge loops indefinitely on a datacenter IP,
  so live board XHRs never fire. Detail parsing is anchored on the stable
  schema.org `JobPosting` JSON-LD contract (Spec 5022), and board enumeration on
  the stable `/postings/{slug}` link shape, both of which are defensive. Logged
  as **Q-<gusto-hosted>** in `docs/questions.md`; a live capture from an
  allowed browser should confirm the board/posting selectors before promoting
  beyond best-effort.
