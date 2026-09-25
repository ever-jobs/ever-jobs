# Performance Tuning

## Caching

- Enable caching to avoid redundant searches: `ENABLE_CACHE=true`
- Tune `CACHE_EXPIRY` based on freshness requirements (default: 3600s)
- Cache is in-memory — restarts clear it. Consider Redis for persistence.

## Concurrency

- Sources run concurrently via `Promise.allSettled` — all sources are queried in parallel
- Reduce `DEFAULT_RESULTS_WANTED` to lower per-source load
- Limit `DEFAULT_SITE_NAMES` to only the boards you need

## Multi-location search (Spec 1700)

A search with `locations` runs every selected source once per location, so the work is roughly
**sources × locations** calls. The knobs:

- `EVER_JOBS_SEARCH_MAX_LOCATIONS` (default 10, clamped to 1-25) caps the locations searched;
  the rest come back as `location:<text>` `bad_input` rows.
- A source's locations run one after another (sources still run in parallel under
  `EVER_JOBS_SEARCH_CONCURRENCY`), `EVER_JOBS_SEARCH_LOCATION_INTERVAL_MS` apart (default 500,
  `0` disables). A plugin that declares its own request gap (`minRequestIntervalMs` on
  `@SourcePlugin`: LinkedIn, Wellfound and Naukri 3 s, Glassdoor and ZipRecruiter 5 s) is never
  asked sooner than that, whatever the interval says.
- Each source's location loop runs inside a scoped response memo
  (`EVER_JOBS_SEARCH_LOCATION_MEMO`, default GET and POST; `get` for GET only; `off` to disable).
  The roughly 850 company and ATS plugins that fetch the whole board and filter by location
  locally send the same request for every location, and every repeat is answered from the memo,
  so N locations cost one board fetch (the board is still parsed N times). A source that sends
  the location to its host builds a different request per location and still makes one request
  each. The memo lives only for that loop; failed requests are never kept.
- Every location call counts against `EVER_JOBS_SEARCH_DEADLINE_MS` (default 120 s). With the
  catalogue-wide default site selection, narrow `siteType` or `locations` if the diagnostics show
  `timeout` rows for skipped locations.
- A source that refuses one location (429, a block, an open circuit breaker) is not asked for the
  rest; those rows say `not attempted`.

## Logging

- Use `LOG_LEVEL=warn` or `LOG_LEVEL=error` in production to reduce I/O
- Use `LOG_LEVEL=debug` only for troubleshooting

## Rate Limiting

- Set `RATE_LIMIT_REQUESTS` and `RATE_LIMIT_TIMEFRAME` based on traffic patterns
- Rate limiting adds minimal overhead (in-memory tracking)

## Node.js Tuning

- Increase `--max-old-space-size` for large result sets:
  ```bash
  NODE_OPTIONS="--max-old-space-size=4096" node dist/apps/api/main.js
  ```
- Use Node.js cluster mode or deploy multiple replicas behind a load balancer

## Docker

- Use multi-stage builds (already configured) to minimize image size
- Set appropriate resource limits in `docker-compose.yml`:
  ```yaml
  deploy:
    resources:
      limits:
        memory: 1G
        cpus: "1.0"
  ```

## Monitoring

- Poll `/health` to track uptime and memory usage
- Use `X-Process-Time` response header to identify slow requests
- Use `X-Request-Id` to trace requests across logs

## Salary Parser

The `extractSalary()` helper in `@ever-jobs/common` (Spec 012)
recognises eight ISO 4217 currencies — `USD / EUR / GBP / CHF /
SEK / NOK / DKK / PLN` — with locale-aware decimal-separator
handling. Plugin authors normalise their `salaryString` text
through this helper to populate `JobPostDto.compensation`
fields the dedup engine (Spec 003) can partition on.

### Detection precedence (Spec 012 / § 7.2)

`parseSalaryCurrency(text, opts?)` walks five tiers, returning
the first hit. The `confidence` field on the result names which
tier fired — useful for downstream merge / dedup gating:

1. **Explicit ISO code** in the text (`'EUR'`, `'GBP'`, …) →
   `confidence: 'iso'`. Word-boundary match — `'EURO'` doesn't
   trigger.
2. **Unique symbol** (`€`, `£`, `zł`, `Fr.`) →
   `confidence: 'symbol'`.
3. **Ambiguous symbol** (`'kr'` for SEK / NOK / DKK) —
   disambiguated by `opts.country` when supplied; falls back
   to SEK without a hint (Q-025) → `confidence: 'symbol'`.
4. **Country fallback** — when no in-text signal but
   `opts.country` is set, use the country's primary currency
   (e.g. `Country.GERMANY` → EUR) → `confidence: 'country'`.
5. **Default** — `opts.defaultCode ?? 'USD'` →
   `confidence: 'default'`.

### Locale dispatch (Spec 012 / § 7.3)

`parseSalaryNumber(raw, locale)` routes the numeric parse via
two locale branches:

- **`'continental'`** — decimal `,`, thousands `.` or U+00A0.
  `'45.000'` → `45000`; `'1 234,56'` → `1234.56`.
- **`'anglo'`** — decimal `.`, thousands `,` or U+00A0.
  `'45,000.50'` → `45000.50`. Also tolerates Swiss
  apostrophe-thousands (`"90'000"` → `90000`) per FR-12.

`extractSalary()` resolves the locale via a four-tier cascade:
explicit `options.locale` → `pickLocale(options.country)` →
currency-natural-locale (USD/GBP/CHF → anglo; EUR/SEK/NOK/DKK/
PLN → continental) → `'anglo'` default. Without an explicit
hint, `'45.000 €'` parses correctly because EUR's natural
locale is continental.

### Spec 014 residual extensions (T01..T03)

Spec 014 (runs #60..#62) lifts three behavioural gaps Spec 012
deferred to follow-on questions ([Q-026](questions.md#q-026--bare-number-salary-range-when-confidence-country-spec-012--t04-spillover) /
[Q-027](questions.md#q-027---not-registered-as-usd-unique-symbol-apostrophe-in-salary-regex-spec-012--t04-spillover)).
All three are dispatcher-shape edits in
`@ever-jobs/common`; no plugin source changes are required —
plugins pick up the new behaviour transparently via the
existing barrel.

- **(a) `$`-symbol promotion to `'symbol'` confidence (T01).**
  `SALARY_UNIQUE_SYMBOLS` now lists `['$', 'USD']` alongside
  `€` / `£` / `zł` / `Fr.`. A `$` anywhere in the input now
  outranks any non-USA `country` hint at the
  `parseSalaryCurrency` slice. Example:

  ```ts
  parseSalaryCurrency('$100,000', { country: Country.GERMANY });
  // → { code: 'USD', symbol: '$', confidence: 'symbol' }
  // (was: { code: 'EUR', symbol: null, confidence: 'country' })
  ```

  Known asymmetry with `extractSalary()`: locale resolution
  (`resolveSalaryLocale`) still cascades through the country
  tier even when the symbol tier resolved currency. With
  `country=GERMANY` the locale stays continental, and a
  literal anglo shape like `"$100,000 - $150,000"` parses as
  `100.000 ≈ 100`. Tracked as
  [Q-035](questions.md#q-035--resolvesalarylocale-doesnt-honour-symbol-tier-precedence-end-to-end-spec-014--t04-discovery);
  the K-suffix variant (`"$100K - $150K"`) bypasses this and
  is the recommended shape for cross-country FR-1 precedence
  end-to-end pinning. Lands in the Spec 015 candidate.

- **(b) Swiss apostrophe-thousands now match the regex directly
  (T02).** `SALARY_NUMBER_REGEX_SRC.anglo` adds `'` to the
  thousands-separator character class
  (`[, ]` → `[, ']`), so literal Swiss inputs span
  the regex match in the FIRST place — the existing
  apostrophe-strip in `parseSalaryNumber` (FR-12) stays as a
  defence-in-depth path. The continental regex source is
  intentionally NOT extended (a continental dual-decimal
  shape like `"45'000,50"` would otherwise mis-classify the
  `'` as a thousands separator and lose the trailing
  decimal). Example:

  ```ts
  extractSalary("CHF 90'000 – CHF 120'000");
  // → { interval: 'yearly', minAmount: 90000, maxAmount: 120000, currency: 'CHF' }
  ```

- **(c) Bare-number ranges parse when a `country` hint is
  supplied (T03).** `extractSalary()` adds a third
  bare-numeric-range regex variant gated on the literal
  string check `detected.confidence === 'country'` (NOT
  `!== 'default'` — that would wrongly include
  `'symbol'` / `'iso'` paths). The bare regex is built
  conditionally — `null` when the guard misses — so the
  no-country-hint hot path doesn't pay any regex-compile
  cost. Example:

  ```ts
  extractSalary('100.000 - 150.000', { country: Country.GERMANY });
  // → { interval: 'yearly', minAmount: 100000, maxAmount: 150000, currency: 'EUR' }

  extractSalary('100.000 - 150.000');  // no country hint
  // → { interval: null, minAmount: null, maxAmount: null, currency: null }
  ```

  The Spec 014 / T04 partial close left two false-positive
  shapes uncovered (Q-035 + Q-036); Spec 015 (runs #65..#68)
  closes both. See "Spec 015 locale & prose-immunity
  extensions" below.

### Spec 015 locale & prose-immunity extensions (T01..T03)

Spec 015 (runs #65..#68) closes the two dispatcher-asymmetry
gaps Spec 014 / T04 surfaced ([Q-035](questions.md#q-035--resolvesalarylocale-doesnt-honour-symbol-tier-precedence-end-to-end-spec-014--t04-discovery)
+ [Q-036](questions.md#q-036--bare-regex-over-matches-plain-prose-under-country-hint-spec-014--t04-discovery))
and re-enables the three deferred Spec 014 / T04 cases. Both
fixes are localised to `resolveSalaryLocale()` and
`extractSalary()`'s body in `@ever-jobs/common`; no plugin
source change is required — plugins pick up the new behaviour
transparently via the existing barrel.

- **(d) Locale short-circuit on symbol-tier resolutions
  (Spec 015 / T01 / FR-1).** `resolveSalaryLocale()` gains a
  new tier ahead of the country branch: when
  `detected.confidence === 'symbol'` AND the resolved
  currency's natural locale (per the new
  `CURRENCY_TO_NATURAL_LOCALE` lookup) is `'anglo'`
  (USD / GBP / CHF), return `'anglo'` immediately, bypassing
  the country tier. The narrowing to anglo-only is
  load-bearing — see Spec 015 / spec.md / § 10 / D-01 — and
  preserves the substitute case `"€45,000 - €60,000" +
  country=USA` (FR-6) which would otherwise mis-parse as
  `45.0` under continental locale. Lifts the FR-1 precedence
  rule "symbol > country" from currency-only to
  currency-AND-locale on the affected branch. Example:

  ```ts
  extractSalary('$100,000 - $150,000', { country: Country.GERMANY });
  // → { interval: 'yearly', minAmount: 100000, maxAmount: 150000, currency: 'USD' }
  // (was: { interval: 'hourly', minAmount: 100, maxAmount: 150, currency: 'USD' }
  //  — country tier routed continental locale and mis-parsed 100,000 as decimal 100)
  ```

- **(e) Bare-path raw-value pre-check (Spec 015 / T01 /
  FR-2; threshold retuned in Spec 019 / T01 / FR-1).**
  `extractSalary()` gains a 3-line guard inserted AFTER
  `parseSalaryNumber` returns and BEFORE the K-suffix
  multiplication: if the match came from the bare regex
  (NOT prefix / suffix), AND neither `match[2]` nor
  `match[4]` is `'k'`, AND `minSalary < lowerLimit`
  (= 1000 with the default `lowerLimit = 1000`), return the
  all-`null` envelope. Bounds the bare-regex
  over-matching surface introduced in Spec 014 / T03
  without disturbing the prefix / suffix paths (FR-5).
  Example:

  ```ts
  extractSalary('5 - 7 years experience', { country: Country.GERMANY });
  // → { interval: null, minAmount: null, maxAmount: null, currency: null }
  // (was: { interval: 'hourly', minAmount: 5, maxAmount: 7, currency: 'EUR' }
  //  — raw 5 annualised via * 2080 = 10400 passed lowerLimit = 1000)

  extractSalary('3 - 5 month internship', { country: Country.GERMANY });
  // → { interval: null, minAmount: null, maxAmount: null, currency: null }
  ```

  The K-suffix bypass is intentional: `extractSalary("$100K -
  $150K", { country: Country.GERMANY })` continues to emit
  USD / 100000 / 150000 / yearly because the K-multiplier
  renders `5K` = `5000` ≥ `lowerLimit ≈ 1000` regardless
  of the threshold (FR-7).

  **Spec 015 / FR-8 closure (Spec 019 / runs #78..#81):** the
  bare-path low-end Continental shape `"100 - 150" +
  country=GERMANY` is now **rejected** because the threshold
  was bumped from `lowerLimit / 12 ≈ 83` to `lowerLimit ≈
  1000`. The raw-value pre-check now rejects every bare-path
  match whose `minSalary < 1000`, eliminating the synthetic
  `{ interval: 'hourly' }` rows on prose like `"team of 100 -
  150 employees"`, `"100 - 150 km commute radius"`, or
  `"benefits include 100 - 150 EUR monthly grocery
  allowance"`. The dimensional rule (no string-content
  inspection) preserves all 73 pre-existing `helpers.spec`
  cases plus the three new T02 pins — `"100 - 150"` rejects,
  `"1000 - 1500"` admits at the boundary as `monthly EUR
  1000..1500`. Plugin authors representing legitimate
  Continental EUR low-end shapes (rare entry-level postings)
  should use the **prefix-anchored EUR symbol** form (`"€100
  - €150"`) or the **suffix-anchored EUR ISO** form (`"100 -
  150 EUR"`); both bypass the bare-path guard via the
  prefix / suffix matching paths and emit faithfully without
  triggering the threshold.

  ```ts
  // Spec 015 / FR-8 documented limitation — closed in Spec 019
  extractSalary('100 - 150', { country: Country.GERMANY });
  // → { interval: null, minAmount: null, maxAmount: null, currency: null }
  // (was: { interval: 'hourly', minAmount: 100, maxAmount: 150, currency: 'EUR' }
  //  — bare-path threshold now lowerLimit = 1000, not lowerLimit / 12 ≈ 83)

  // Boundary admit at threshold
  extractSalary('1000 - 1500', { country: Country.GERMANY });
  // → { interval: 'monthly', minAmount: 1000, maxAmount: 1500, currency: 'EUR' }

  // Plugin-author escape hatch: prefix-anchored EUR symbol
  extractSalary('€100 - €150', { country: Country.GERMANY });
  // → { interval: 'hourly', minAmount: 100, maxAmount: 150, currency: 'EUR' }
  //   (prefix path bypasses the bare-path guard)

  // Plugin-author escape hatch: suffix-anchored EUR ISO
  extractSalary('100 - 150 EUR', { country: Country.GERMANY });
  // → { interval: 'hourly', minAmount: 100, maxAmount: 150, currency: 'EUR' }
  //   (suffix path bypasses the bare-path guard)
  ```

### Example call patterns

```ts
import { extractSalary } from '@ever-jobs/common';
import { Country } from '@ever-jobs/models';

// Pre-Spec-012 USD path — unchanged
extractSalary('$100,000 - $150,000');
// → { interval: 'yearly', minAmount: 100000, maxAmount: 150000, currency: 'USD' }

// Continental EUR with country hint
extractSalary('45.000 € – 60.000 €', { country: Country.GERMANY });
// → { interval: 'yearly', minAmount: 45000, maxAmount: 60000, currency: 'EUR' }

// Nordic kr disambiguated by country
extractSalary('500.000 kr - 700.000 kr', { country: Country.DENMARK });
// → { interval: 'yearly', minAmount: 500000, maxAmount: 700000, currency: 'DKK' }

// Plugin-author shortcut: pass the country once and let the
// parser pick locale + currency together.
extractSalary(input.salaryString, { country: input.country });
```

### Performance budget (Spec 012 / § 6, NFR-1..NFR-5)

| ID    | Requirement                              | Target                                  |
| ----- | ---------------------------------------- | --------------------------------------- |
| NFR-1 | Parser latency (single call)             | ≤ 0.5 ms p95 on a 200-char input        |
| NFR-2 | No new external runtime deps             | 0 — pure regex + Map dispatch           |
| NFR-3 | Bundle-size delta (`@ever-jobs/common`)  | ≤ +2 KB minified                        |
| NFR-4 | Memory (per call)                        | ≤ 4 KB transient — no caches            |
| NFR-5 | Test-suite delta (`helpers.spec.ts`)     | ≥ +14 cases, all green; ≤ +50 ms total  |

The micro-bench in
`packages/common/__tests__/helpers.bench.spec.ts` runs 1 000
warm-up + 5 000 measurement iterations on a 200-character
input mix and writes `dist/bench/helpers-salary.json` with
overall + per-currency `p50 / p95 / p99`. CI asserts
`p95 < 2.0 ms` (4× headroom over NFR-1's 0.5 ms target — keeps
the gate insensitive to GitHub-Actions runner cold-starts).
