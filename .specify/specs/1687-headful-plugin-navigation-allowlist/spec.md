# Spec: 1687 — the browser goes where the plugin says, not where the caller says

| Field          | Value                                              |
| -------------- | -------------------------------------------------- |
| Spec ID        | 1687                                               |
| Slug           | headful-plugin-navigation-allowlist                |
| Status         | done                                               |
| Owner          | agent                                              |
| Created        | 2026-09-03                                         |
| Last updated   | 2026-09-03                                         |
| Supersedes     | (none)                                             |
| Related specs  | 5089, 5091, 5092                                   |

## 1. Problem Statement

Two company plugins merged from the fork (`source-company-rdw`, Spec 5091, and
`source-company-trossenrobotics`, Spec 5092) drive a shared headful Chromium through
`BrowserPool`, and both take their start URL straight from the caller:

```ts
const startUrl = input.companyUrl || TROSSENROBOTICS_CAREERS_URL;
await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout });
```

`ScraperInputDto.companyUrl` is `@IsString()` and nothing else, `POST /api/jobs/search` is
unauthenticated by default (`auth.enabled` defaults to `false`, and the production manifest
documents the API as cluster-internal with the guard off), so the value is attacker-controlled
in the same sense the `source-ats-submit4jobs` embed host was in #47. The second untrusted
value is every `href` read off a fetched board page: `resolveUrl()` returns an absolute href
unchanged, so a tampered listing re-points the next `page.goto`.

Trossen makes the consequence a read primitive rather than a blind one. `extractDescription`
falls back to the whole `<body>` of whatever was fetched, so the page the browser was aimed at
comes back inside `JobPostDto.description`.

Three further defects in the same family of plugins, found in the same review:

- **RDW discards a whole board for one bad page.** The detail fetch has no `try`, so a single
  navigation failure at job 60 of 66 throws away the 59 already parsed.
- **RDW crawls the entire board before honouring `resultsWanted`.** `applyInput` slices after
  every page and detail has been fetched, so a default `resultsWanted: 50` still pays for the
  full board against a 120 s fan-out deadline.
- **Stratolaunch (Spec 5089) decodes HTML entities to a fixpoint.** `decodeFully` loops until
  the string stops changing; the cost is quadratic in nesting depth and the input is remote.
  Measured against the real helper: ~0.2 s at 10 KB of nested `&amp;amp;…`, ~1.5 s at 30 KB,
  ~5.4 s at 60 KB, all of it blocking the event loop. Its board token is also interpolated into
  the Greenhouse API path unvalidated.
- **SuccessFactors blames the caller for a correct request.** After Spec 5087, a bare
  `companySlug` whose derived CSB portal *is* verified and read, but which lists nothing,
  returns `bad_input: missing companyUrl` — the one thing that was not wrong.

## 2. Decisions

- **D-01 — Fail closed, per plugin.** Each plugin owns an `isAllowed…Url` predicate over its own
  registrable domain, mirroring `isAllowedSubmit4jobsApiHost` from #47. Parsing with `URL` and
  reading `hostname` is what rejects `https://evil.com/x.rdw.com`,
  `https://user@evil.com#.rdw.com` and `file:///etc/passwd` — a raw-string suffix match does not.
- **D-02 — An off-domain `companyUrl` is ignored, not fatal.** A company plugin exists to scrape
  one company, so its own board is always the right answer; the rejection is logged. An off-site
  href is skipped and the rest of the board still returns.
- **D-03 — Partial results beat none.** Per-card `try`/`catch` plus an `N of M detail requests
  failed` summary, the shape Spec 5084 established for Workday.
- **D-04 — Stop early only when nothing can filter a later job in.** `applyInput` runs after the
  crawl, so the budget applies only when `searchTerm`, `location`, `isRemote` and `jobType` are
  all absent.
- **D-05 — Bound the decode instead of removing it.** Greenhouse double-escapes some content and
  the live board fixture needs two passes, so a single pass would change output. Three passes
  clear every real posting and make the cost linear.
- **D-06 — An empty scrape reports `empty`.** Spec 1683's rule applied to the two new plugins,
  and `empty` replaces the misleading `bad_input` on the verified-but-empty SuccessFactors path.
- **D-07 — Not changed here: the title-prefix regex.** `[,–—-]?` makes the separator optional, so
  "Remote Sensing Engineer" loses its first word — but the fork's own fixture asserts that
  "Temporary Instructional Designer" *is* stripped without one. Both cannot hold. Left for the
  fork to settle rather than silently redefined, and recorded in `docs/questions.md`.
- **D-08 — A swallowed failure is worse than a lost job.** Catching per-card and per-page errors
  (D-03) creates a new way to lie: a page-one timeout would return `empty` ("this board has no
  jobs") and a half-harvested board would return no diagnostic at all, which `JobsService` scores
  as `ok`. `fetchJobs` therefore returns the failure alongside the jobs, and `scrape` reports the
  classified cause when nothing was harvested, or a `N of M detail requests failed` detail when
  some were — the non-empty-plus-diagnostic pair `JobsService` already turns into `partial`
  (Spec 1680). Raised by Greptile on PR #84.

## 3. Non-goals

- No change to `BrowserPool`, to `ScraperInputDto` validation, or to the API's auth defaults.
- No removal of the `companyUrl` and `companySlug` overrides — they keep working within the
  plugin's own domain.
- No new shared helper in `@ever-jobs/common`: two call sites with different allowed hosts, and
  the established precedent (#47) is per-plugin constants.

## 4. Acceptance

- A caller-supplied `companyUrl` off the plugin's domain is never fetched; the plugin's own board
  is read instead and the rejection is logged.
- An absolute off-site href on a fetched board page is never fetched; the remaining jobs return.
- One failing detail navigation costs one job, not the board.
- With no filter set, `resultsWanted: 1` against a two-card board fetches one detail page; with a
  filter set, both are fetched.
- A 60 KB nested-entity chain returns in well under a second.
- A Stratolaunch board token that is not `^[A-Za-z0-9_-]+$` falls back to its own board.
- A verified-but-empty SuccessFactors CSB portal reports `empty`, naming the portal.
- A board whose first page fails reports the classified cause, never `empty`; a board that lost
  some detail pages returns its jobs *and* a diagnostic naming the count.
