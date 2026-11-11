# Spec 1754 — Canonical job-URL dedup

## Problem

The same posting reaches one run through several routes whose links differ only by campaign
tracking parameters or host casing. The dedup engine clusters on company/title/location; nothing
skips an exact repeat of the same link, and nothing logs why a repeat was dropped.

## Scope

- `canonicalJobUrl(url)`: absolute http(s) only; lower-case host, default port dropped; `utm_*`,
  `gclid`, `fbclid`, `msclkid`, `gh_src`, `lever-source` and similar pure-tracking parameters removed;
  remaining parameters sorted; path, other parameters and fragment untouched.
- `dropDuplicateJobUrls(jobs)`: first seen wins; a posting is a duplicate only when canonical URL
  **and** normalised title match (plugins that fall back to one shared listing URL must not lose
  distinct roles). Postings without a usable `jobUrl` are always kept.
- `JobsAggregator`: runs the pass before the dedup engine when `AggregateOptions.dedupByUrl` is true
  or `EVER_JOBS_DEDUP_BY_URL` is truthy. Default off. Logs the reason `duplicate_canonical_url`
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
