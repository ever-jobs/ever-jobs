# Spec: 1752 — ReliefWeb on API v2 (v1 is decommissioned)

| Field          | Value                                                            |
| -------------- | ---------------------------------------------------------------- |
| Spec ID        | 1752                                                             |
| Slug           | reliefweb-api-v2                                                 |
| Status         | done (code) — live data blocked on an approved appname (owner)   |
| Owner          | agent                                                            |
| Created        | 2026-09-25                                                       |
| Last updated   | 2026-09-25                                                       |
| Supersedes     | (none)                                                           |
| Related specs  | 1751 (the ReliefWeb `href` link fix this builds on)              |

## 1. Problem Statement

`source-reliefweb` called `https://api.reliefweb.int/v1/jobs`. ReliefWeb has decommissioned
v1; checked live on 2026-09-25:

```
GET https://api.reliefweb.int/v1/jobs?appname=ever-jobs&limit=1
→ 410 {"status":410,"time":1,"error":{"type":"Exception",
        "message":"The API version 'v1' has been decommissioned. Please use version 'v2' instead."}}
```

So the source returned nothing on every run (`classifyScrapeError` filed the 410 as
`bad_input`).

The current docs (https://apidoc.reliefweb.int/) say v2 is "fully compatible" with v1 —
same `GET /v2/<content type>` shape and the same parameters (`appname`, `limit`, `offset`,
`fields[include][]`, `query[value]`, …) — with one new condition: **"From 1 November 2025,
you need to use a pre-approved appname"**, requested through a form linked from
https://apidoc.reliefweb.int/parameters#appname ("a combination of your (organization) name,
purpose and random characters"). Checked live the same day:

```
GET https://api.reliefweb.int/v2/jobs?appname=ever-jobs&limit=2&…
→ 403 {"status":403,"time":25,"error":{"type":"AccessDeniedHttpException",
        "message":"You are not using an approved appname. Kindly request an appname from
                   ReliefWeb here: https://apidoc.reliefweb.int/parameters#appname"}}
```

No approved appname exists for this project, so no live v2 job list could be captured.

## 2. Scope

- Move the endpoint to `https://api.reliefweb.int/v2/jobs`.
- Make the appname configurable: `RELIEFWEB_APPNAME` (trimmed, read on every scrape), else
  the neutral `ever-jobs`. Warn at start-up when it is unset.
- Report ReliefWeb's "not an approved appname" 403 as a `bad_input` diagnostic whose detail
  names the appname sent, `RELIEFWEB_APPNAME` and the request URL — not as `blocked`, which
  would send an operator looking for an IP block. Any other 403 is still `blocked`.
- Links (Spec 1751 continued): `jobUrl` = `url_alias` (the "'Friendly' url of the job",
  `https://reliefweb.int/job/<id>/<slug>`), else `url` (the "Canonical url"), each only if it
  is a public `http(s)` URL (`firstPublicUrl`), else `https://reliefweb.int/node/<id>`.
  `href` (`https://api.reliefweb.int/v2/jobs/<id>`) is never a link.
- Descriptions: v2 `body` is Markdown and `body-html` its HTML. `HTML` → `body-html`
  (else `body`); `PLAIN` → text of `body-html` (else `body`); `MARKDOWN` → `body`; no
  format → `body`, as before.

## 3. Non-goals

- Obtaining an appname (an owner action — §6).
- Paging past the first `limit` entries, `preset=latest` sorting, `city` locations — the v1
  behaviour is kept.
- Per-request appname (`input.auth.reliefweb`) — would need a new auth DTO in
  `@ever-jobs/models`; the env variable matches how Adzuna/USAJobs/CareerOneStop are keyed.

## 4. Decisions

- **D-01 — Default appname stays `ever-jobs`.** It is neutral and what the plugin sent under
  v1; it is not approved, so without `RELIEFWEB_APPNAME` the source returns zero jobs with an
  actionable diagnostic. Skipping the request when unset was rejected: an owner who registers
  `ever-jobs` itself would then get nothing.
- **D-02 — Link precedence `url_alias` → `url` → `/node/<id>`.** Verified live (2 GETs to
  reliefweb.int): `https://reliefweb.int/node/4231248` → **301** to
  `https://reliefweb.int/job/4231248/full-stack-software-developer`; `/node/4228316` (a closed
  job) → **410 HTML** whose `<link rel="canonical">` is `/job/4228316/operations-officer`. So
  the node path reaches the job page but is not itself a 200 — the alias is, which is why it
  goes first. (The 200 of the alias target itself was not fetched: the two-request budget was
  spent on the node path.) The shape of v2 `url` (node path or alias) could not be observed;
  the mapping does not depend on it.
- **D-03 — The 403 is matched on the error message mentioning `appname`**, not on the status
  alone, so a real block stays `blocked`.

## 5. Contracts

- Env: `RELIEFWEB_APPNAME` (optional; documented in `.env.example` and README).
- Request: `GET https://api.reliefweb.int/v2/jobs?appname=<name>&limit=<≤100>&offset=0&fields[include][]=title&…body&…body-html&…url&…url_alias&…source&…date&…country&…theme&…type[&query[value]=<searchTerm>]`.
- Response → `JobPostDto`: `id = reliefweb-<id>`, `title`, `companyName = source[0].name`,
  `jobUrl` per D-02, `location(s)` from `country[].name`, `datePosted = date.created`,
  `emails` from the description, `site = reliefweb`.
- Failure: 403 + appname message → `JobResponseDto([], {reason:'bad_input', detail})`; other
  errors → `classifyScrapeError`.

## 6. Owner action

Request an appname at https://apidoc.reliefweb.int/parameters#appname and set
`RELIEFWEB_APPNAME` in each environment. Until then ReliefWeb yields no jobs (it yielded none
under v1 either, since the 410).

## 7. Test plan / acceptance

- `reliefweb.v2.spec.ts` (9): request goes to `/v2/jobs` with the default appname and the v2
  fields; `RELIEFWEB_APPNAME` overrides (trimmed; blank → default); the verbatim live 403 body
  → `bad_input` naming the appname, the variable and the URL; another 403 → `blocked`; the
  verbatim live v1 410 → `bad_input`; a v2 list maps every entry with public links only; each
  description format comes from the matching field.
- `reliefweb.job-url.spec.ts` (4): `url_alias` before `url`; `url` alone; neither → node
  page; API-shaped values refused.
- Red control: against the pre-change service 6 of the 13 fail.
- `scripts/__tests__/plugin-job-url-hosts.spec.ts` stays green (the v2 API base is only
  fetched).
