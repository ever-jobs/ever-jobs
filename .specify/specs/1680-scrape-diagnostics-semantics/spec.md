# Spec: 1680 — Diagnostics semantics, and the two backends that gate 300 wrappers

| Field          | Value                                      |
| -------------- | ------------------------------------------ |
| Spec ID        | 1680                                       |
| Slug           | scrape-diagnostics-semantics               |
| Status         | done                                       |
| Owner          | agent                                      |
| Created        | 2026-08-18                                 |
| Last updated   | 2026-08-18                                 |
| Supersedes     | (none)                                     |
| Related specs  | 5082, 1679                                 |

## 1. Problem Statement

Spec 5082 gave plugins a way to report *why* a scrape produced what it did, and Spec 1679 made that
reporting cheap enough to ship. Neither fixed the fact that almost nothing reports anything: a
census of all **1,839** plugin services found only **45** that construct a `ScrapeDiagnostics`.

This spec is the first of a sequence and deliberately does **not** touch the ~1,500 plugins. It
fixes the four things that every later PR would otherwise hard-code the wrong answers to.

### 1.1 `classifyScrapeError` had no 4xx rule

The classifier matched `\b5\d\d\b` and `\b429\b` for `fetch_error`, and `403` for `blocked`.
Everything else 4xx — **including 404** — fell through to `unknown`.

A 404 is the single most likely failure across a catalogue of ~1,540 scaffolded company boards: it
is what a slug that no longer resolves returns. Reporting the most common and most actionable
failure in the tree as "unknown" is the classifier's worst case, not an edge case.

### 1.2 A partial scrape reported as a complete one

`JobsService` inferred `jobs.length > 0 ? 'ok' : (diag?.reason ?? 'empty')`. A source that returned
30 postings and *then* hit a 403 was therefore reported `ok` — a partial outage hidden behind a
non-zero count. Worse, `detail` was still passed through, so an `ok` row could carry an error string.

### 1.3 Prometheus counted a failed scrape as a success

`scraperRequestsTotal.inc({ site, status: 'success' })` fired on any resolved promise. Because a
swallowing plugin resolves normally, a fully-failed scrape incremented `status="success"`. Every
dashboard built on that counter was wrong, and would have *stayed* wrong after the plugin migration
— the reason would improve in the `per_source` JSON field and nowhere else.

### 1.4 Two backends gate ~300 delegating wrappers

699 `source-company-*` plugins carry no scraping logic; they delegate to a backend ATS plugin via
`registry?.getScraper(...)` and return its result verbatim. So the wrapper's reported reason is
whatever its backend reports:

| Backend | Wrappers | Reported a reason? |
|---|---:|---|
| Ashby | 218 | yes |
| Lever | 179 | yes |
| **SmartRecruiters** | **213** | **no** |
| **Recruitee** | **82** | **no** |

`smartrecruiters.service.ts:116` was the worst single defect found: `return new
JobResponseDto(jobPosts); // Return what we have so far` — partial results with **no signal at
all**, so a page-2 failure was indistinguishable from a complete board. Fixing these two files fixes
~295 wrappers without editing any of them.

## 2. Goals

- Classify the failure that actually dominates this catalogue.
- Distinguish "worked", "worked partly", and "returned nothing" at the fan-out.
- Make the metrics tell the same story as the API.
- Unblock the ~300 wrappers whose backends were silent.

## 3. Non-Goals

- The 822-file canonical-swallow codemod, the 699 delegating specs, the six scaffolders, and the
  268-file tail. Those are later PRs in this sequence and all depend on the semantics settled here.
- Making plugins **throw**. See §5 — it would be actively harmful.
- Recovering partial results in `recruitee` and `ashby`/`lever`, whose accumulators are declared
  *inside* the `try` and so are out of scope in the catch. That needs a hoist and its own test
  review; `smartrecruiters` already had its accumulator outside and now reports partials correctly.

## 4. Design

### 4.1 Two new `ScrapeReason` members

`partial` — jobs were returned **and** something failed. `not_registered` — a delegating plugin
could not resolve its backend, a wiring problem distinct from `empty` because no request was made.

Both are added to `ACTIONABLE_SCRAPE_REASONS` (Spec 1679), so both survive the default filter.
Widening the union is safe: `ScrapeReason` is referenced outside `packages/models` in exactly two
lines, both in `jobs.service.ts`, with no exhaustive `switch`, no `: never` check and no
`@ApiProperty` enum.

### 4.2 Classifier

Rule order matters and is preserved: browser → timeout → blocked → fetch_error → **4xx** → unknown.
`403`/`401`/`407` stay `blocked` (401/407 newly matched, alongside `unauthorized`); `429` stays
`fetch_error`; everything else 4xx, plus a worded "not found", becomes `bad_input`.

### 4.3 Inference and metrics

```ts
const reason: ScrapeReason =
  jobs.length > 0 ? (diag ? 'partial' : 'ok') : (diag?.reason ?? 'empty');
```

```ts
const outcome = response.diagnostics?.reason;
this.metrics.scraperRequestsTotal.inc({
  site,
  status: !outcome ? 'success' : response.jobs.length > 0 ? 'partial' : outcome,
});
```

### 4.4 The two backends

Both now report via `classifyScrapeError(err)`, and both `if (!companySlug)` guards — which returned
a bare empty result, indistinguishable from an empty board — now report `bad_input`.

## 5. Why plugins must keep resolving, never throwing

The obvious alternative is to let errors propagate so the fan-out's `rejected` branch classifies
them. It was checked and it is disqualifying.

`CircuitBreakerService` accounts failures **only on rejection** — a resolved `JobResponseDto`, with
or without diagnostics, always takes the `onSuccess` path. So this change cannot produce a single
new `circuit_open` row. Making ~822 plugins throw would instead:

- trip breakers on any source merely returning 403, replacing the real reason with "we stopped
  calling it" within five fan-outs (`failureThreshold: 5`);
- overflow `MAX_SITES = 250` against **1,832** registered sites, so ~1,580 sources would get an
  ephemeral breaker entry that accumulates no state **and logs an error on every call**;
- and, because the 699 wrappers share four backend hosts, let one 429 trip up to 218 breakers at once.

**Resolve, always.**

## 6. Acceptance

- 404/410/400/422 and worded not-found classify as `bad_input`; 401/407 as `blocked`; 429 stays
  `fetch_error`; 403 stays `blocked`.
- Jobs + a diagnostic infers `partial`; jobs alone `ok`; zero + diagnostic the plugin's reason; zero
  alone `empty`.
- The Prometheus `status` label follows the diagnostic, and stays `success` when none is reported.
- SmartRecruiters returns partial results *with* a reason; both slug guards report `bad_input`.

## 7. Risks

- `status="success"` on `scraperRequestsTotal` becomes narrower, so any dashboard summing it will
  show a step change. That is the defect being fixed, not a regression — but it is visible.
- New label values (`partial`, `bad_input`, …) appear on an existing metric.
