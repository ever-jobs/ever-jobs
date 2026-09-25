# Spec: 1751 — no plugin hands people an API URL as a job link

| Field          | Value                                                   |
| -------------- | ------------------------------------------------------- |
| Spec ID        | 1751                                                    |
| Slug           | plugin-job-link-guard                                   |
| Status         | done                                                    |
| Owner          | agent                                                   |
| Created        | 2026-09-25                                              |
| Last updated   | 2026-09-25 (T11 record/helper sinks, T12 NAV id proof)  |
| Supersedes     | (none)                                                  |
| Related specs  | 1750 (the SmartRecruiters `ref` leak that prompted this) |

## 1. Problem Statement

`JobPostDto.jobUrl`, `jobUrlDirect` and `applyUrl` are the links a person clicks: a
downstream app renders Apply as `applyUrl ?? jobUrl ?? jobUrlDirect`. Spec 1750 found
SmartRecruiters putting its API resource (`ref`) there for every posting. The question this
spec answers is whether any other plugin does the same, and how to stop the next one.

An audit derived from the source — not from memory — enumerated every assignment to the
three fields across `packages/plugins/*/src/**/*.ts` with the TypeScript parser (1,791 sites
in 1,164 plugins; `rg '\b(jobUrl|jobUrlDirect|applyUrl)\s*[:=]'` finds 1,618 lines, which
also counts type declarations and misses shorthand properties). The full classification and
every flagged row is in [notes.md](notes.md). Besides SmartRecruiters it found:

| Plugin | Field | Source | Verdict |
| --- | --- | --- | --- |
| `source-reliefweb` | jobUrl | `fields.url ?? entry.href` — `href` is `https://api.reliefweb.int/v1/jobs/<id>` | leak on fallback — **fixed** (and moved to API v2 by Spec 1752: v1 answers 410) |
| `source-navjobs` | jobUrl | `applicationUrl ?? sourceurl ?? item.url` — `item.url` is `/api/v1/feedentry/<uuid>` | leak on fallback — **fixed** |
| `source-ats-hiringthing` | jobUrl | `job.url ?? https://api.hiringthing.com/jobs/<id>` | api-host fallback — **partly fixed** (Q-110) |
| `source-ats-loxo` | jobUrl | `url ?? apply_url ?? https://app.loxo.co/api/<slug>/jobs/<id>` | API fallback — **partly fixed** (Q-110) |
| `source-ats-bullhorn` | jobUrl | always `https://public-rest<cls>.bullhornstaffing.com/rest-services/<token>/entity/JobOrder/<id>` | REST link — **partly fixed** (Q-110) |
| `source-ats-ceipal` | jobUrl, applyUrl | `apply_job ?? https://api.ceipal.com/<key>/job-postings/<id>/` | JSON fallback — **partly fixed** (Q-110) |
| `source-ats-zwayam` | jobUrl | `https://api.zwayam.com/job_preview/?jobUrl=…` | API host **by design**: the plugin documents it as the platform's public share page — unchanged, unverified (Q-110); a named guard exception since T11 |

"Partly fixed": no public posting page is known for those tenants, so the plugin now prefers
every public candidate and the caller's `companyUrl`, and keeps the old link only as the last
resort.

## 2. Decisions

- **D-01 — One shared definition of "API-shaped".** `@ever-jobs/common` gains
  `public-url.ts`: `API_URL_PATTERN` (an `api.`/`*-api.`/`graphql.` host label; `/api/`,
  `/v1/`, `/graphql`, `/rest-services/`, `/hcmRestApi/`, Workday `/wday/cxs/`; `.json`),
  `isApiLikeUrl()` and `firstPublicUrl(...candidates)` — the first absolute `http(s)` URL that
  is not API-shaped. It lives in `utils/`, not `http/` (another session owns that folder).
- **D-02 — Runtime: pick links with `firstPublicUrl`.** Every fixed plugin chooses its link
  through it, so an API-shaped value from a response can never win.
- **D-03 — Static guard, derived from source.** `scripts/__tests__/plugin-job-url-hosts.spec.ts`
  parses every plugin with the TypeScript compiler and fails when a link-field value reads an
  API reference field (`.ref`, `.self`, `.apiUrl`, `.api_url`, `.resource_uri`) or contains a
  URL fragment matching `API_URL_PATTERN` — directly, through a local (resolved lexically, so
  two functions' `url` locals never mix), a same-plugin constant or `CONSTANTS.KEY`, a
  same-plugin helper's `return`, a `TEMPLATE.replace()` receiver, or a `URL` accessor
  (`u.origin`). A call's arguments are not treated as the value for the field rule
  (`parseRef(job.ref)` transforms `ref`), and a fetched object's field (`detail.applyUrl`)
  is not traced back to the URL it was fetched from.
- **D-04 — Exceptions are named, justified and self-expiring.** Bullhorn, Ceipal, HiringThing
  and Loxo still emit the old link as a last resort; the guard lists each with its reason and
  fails if an excused plugin stops producing a finding. Zwayam builds its link in an
  intermediate record the first guard could not follow; since T11 (D-07) the guard follows it,
  so Zwayam is the fifth named exception — "by design, unverified", not "last resort".
- **D-05 — Plugins another session owns are reported, not edited.** `linkedin`, `glassdoor`,
  `ziprecruiter` and `naukri` were audited; all four link human pages (notes.md), so there is
  nothing to hand over.
- **D-06 — Public fallbacks are the platforms' page patterns.** ReliefWeb:
  `https://reliefweb.int/node/<id>` (the site's Drupal node path; the API's own `url_alias` /
  `url` are requested and preferred — Spec 1752). Checked live 2026-09-25: `/node/4231248` →
  301 to `/job/4231248/full-stack-software-developer`; a closed job's node path → 410 HTML with
  the alias as `rel=canonical` — it reaches the job page, but only through a redirect, which is
  why Spec 1752 puts `url_alias` first. NAV: `https://arbeidsplassen.nav.no/stillinger/stilling/<uuid>`
  — **proved the same id** (T12): in NAV's own feed service (navikt/pam-stilling-feed @
  `45cc8c49`) a list line's `id` and `_feed_entry.uuid` are both `feedItemId`, set as
  `UUID.fromString(ad.uuid)` (`FeedService.kt`), and the entry's `ad_content.link` is
  `"$stillingUrlBase/${ad.uuid}"` with `stilling_url_base =
  https://arbeidsplassen.nav.no/stillinger/stilling` (`naiserator-prod.json`); one live GET of
  `…/stilling/0862f420-5aea-4532-af73-43156a9e7b7f` answered 200 HTML titled "Midlertidig
  stilling som prosjektmedarbeider", showing that uuid as its *Stillingsnummer* and as
  `adData.id`. The fallback therefore equals the link NAV publishes; no change was needed.
- **D-07 — Links built one step early (T11).** Mutant M7 showed the gap: Carerix's
  `buildJobUrl()` returning `https://api.carerix.com/v1/jobs/<id>` passed the guard, because
  `normaliseJob` stores it as `{ url: … }` and `processJob` copies `job.url` — a parameter —
  into `jobUrl`. Two sinks were added: (3) any value assigned to a record key `url` / `link` /
  `href` (object literal, shorthand, member assignment) is judged like a link field, except in
  a request config (`method`/`headers`/`params`/`data`/`body`/… keys, or an object passed
  straight to `get`/`post`/`request`/`fetch…`); (4) every same-plugin function, method or arrow
  constant whose name contains `url` has all its `return` values judged, wherever the result
  goes — unless every call site hands the result to a request (`client.get(u)`,
  `this.fetchJson(u)`, `page.goto(u)`, a request config), directly or through locals,
  templates, `new URL()`, string methods or a helper that returns it; logging, truth tests and
  member reads (`url.length`) are neutral. That exemption keeps fetch builders (`adpListUrl`,
  `buildWorkdayUrl`, `manatalListUrl`, …) out: on 2026-09-25 the tree has 197 record links, 348
  URL-named helpers judged as links and 93 exempted as fetch helpers, with zero findings outside
  the named exceptions. Proven by four mutants (M7 method helper, M8 arrow helper, M9 template
  in a `Map`, M10 inline template in the record) — each passes the previous guard and fails
  this one (notes.md).

## 3. Non-goals

- Judging runtime values statically. `job.url` from a response cannot be proved human by
  reading code; `firstPublicUrl` guards those in the fixed plugins, and the audit's "API /
  feed field" rows are verdicts from each source's documented contract, not live checks.
- Links that are human but questionable — Workday's `externalPath` joined to the host without
  the site segment when `externalUrl` is missing, Oracle's `<host>/careers/job/<id>`
  fallback, PDF postings (`canekast`, `desktopmetal`). Listed in notes.md for a later pass.
- Dropping postings that have no public link. That is the product question in **Q-110**.

## 4. Acceptance

- `public-url.spec.ts`: 28 cases (13 API shapes flagged, 10 human pages not flagged, blanks,
  the exported pattern, candidate selection).
- The guard scans > 1,000 plugins / > 1,400 link assignments / > 150 record links / > 300
  URL-named link helpers (> 60 exempted fetch helpers), reports nothing outside the five named
  exceptions, and every exception still applies.
- Mutants M7–M10 (D-07) pass the pre-T11 guard and fail it after T11.
- Each fixed adapter has a unit suite (`*.job-url.spec.ts`) that goes red against the pre-fix
  service (13 of 22 cases) and green after.
- Reintroducing `job.ref` in SmartRecruiters makes the guard fail.
