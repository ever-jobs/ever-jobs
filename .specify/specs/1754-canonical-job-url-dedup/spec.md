# Spec 1754 — Canonical job-URL dedup

| Field        | Value      |
| ------------ | ---------- |
| Spec ID      | 1754       |
| Status       | done       |
| Last updated | 2026-11-12 |

## Problem

The same posting reaches one run through several routes whose links differ only by campaign
tracking parameters or host casing. The dedup engine clusters on company/title/location; nothing
skips an exact repeat of the same link, and nothing logs why a repeat was dropped.

## Scope

- `canonicalJobUrl(url)`: absolute http(s) only; lower-case host, default port dropped; `utm_*`,
  `gclid`, `fbclid`, `msclkid`, `gh_src`, `lever-source` and similar pure-tracking parameters removed;
  remaining parameters sorted; path, other parameters and fragment untouched.
- `dropDuplicateJobUrls(jobs, { roleKey, keep })` (async, yields to the event loop every 500
  postings): first seen wins; a posting is a duplicate only when canonical URL **and** role key match
  (default: normalised title; the aggregator passes the same company, title, location and employment
  class key, so one shared listing URL never merges different cities, companies or an internship
  with a full-time role). Postings without a usable
  `jobUrl` or role key are always kept. `keep` exempts postings from skipping; the aggregator uses it
  for postings the caller's exclusion filter matches, so the skip pass can never hide a match from
  the filter (or from its "any cluster member matches" rule).
- `JobsAggregator`: runs the pass when `AggregateOptions.dedupByUrl` is true or
  `EVER_JOBS_DEDUP_BY_URL` is truthy, only when the dedup engine does not run (`dedup=false` or no
  engine bound): with the engine on, the pass would merge nothing extra but would drop the skipped
  postings' source observations from the persisted record. Same canonical URL and the same company,
  title, location and employment class. Default off. Logs the reason `duplicate_canonical_url`
  (first 20 per call at debug, a count at log level) and returns `urlDuplicatesSkipped`.

## Non-goals

Cross-run duplicate detection, stripping `www.` or trailing slashes, fuzzy URL matching, a new
request parameter or HTTP surface, persistence of skip records.

## Contracts

`rawCount` still equals the fan-out size; `outputCount` is post-skip and post-dedup;
`urlDuplicatesSkipped` is present only when it is > 0.

## Test plan

Unit: normalisation (tracking, host case, port, sorting, fragment, invalid input), first-seen-wins,
shared-listing-URL guard, input immutability. Aggregator: off by default, option, env, with engine.
