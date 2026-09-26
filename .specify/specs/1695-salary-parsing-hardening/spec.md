# Spec: 1695 — Salary parsing hardening

| Field          | Value                                    |
| -------------- | ---------------------------------------- |
| Spec ID        | 1695                                     |
| Slug           | salary-parsing-hardening                 |
| Status         | done                                     |
| Owner          | agent                                    |
| Created        | 2026-09-25                               |
| Last updated   | 2026-09-25                               |
| Supersedes     | (none)                                   |
| Related specs  | 012, 014, 015, 019, 5018, 5045, 5058     |

## 1. Problem Statement

The shared salary helpers in `packages/common/src/utils/helpers.ts` feed the API post-processor
and about 37 plugins. Several shapes that job postings use every day came out wrong or not at
all:

| Input | Before | Problem |
| ----- | ------ | ------- |
| `parseCurrency('Negotiable')`, `('')`, `('-')` | `NaN` | NaN can flow into amounts |
| `parseCurrency('$100K')` | `100` | K suffix dropped |
| `convertToAnnual({hourly, min 25, max null})` | `{yearly, 52000, 0}` | a missing bound became `0` |
| `extractSalary('$20/hr - $25/hr')`, `'$53,000.00/yr - $65,000.00/yr'`, `'45.000 €/Jahr - 60.000 €/Jahr'` | nothing | a period token after the first amount breaks the range match |
| `extractSalary('$20,000 - $25,000 per year')` | monthly 20000-25000 | the stated period is ignored; magnitude guesses |
| `extractSalary('$400 - $500/hr')` | monthly 400-500 | should be hourly, and then fail the ceiling |
| `extractSalary('$200 - $300 daily')` | hourly 200-300 | magnitude cannot express daily or weekly |
| `extractSalary('$25/hr+')` | nothing | the token sits between the amount and `+` |
| `extractSalary('$100,000 to $150,000')`, `'$40/hr to $120/hr'` | nothing | only dash separators are read |
| `extractSalary('$5 - $10 million in funding')` | hourly 5-10 | a funding figure read as a wage |

On full job pages the missing `to` separator does more than lose a salary: when the job states
`The total compensation range for this role is $220,000 to $290,000`, the first dash range on the
page wins instead — on one sampled page, a different employer's "similar jobs" card.

The API post-processor (`JobsService.postProcessSalary`) adds four more: a single-bound direct
salary is never annualised, a max-only salary loses its `salarySource`, a description salary is
annualised but keeps its source interval (`hourly` with yearly amounts), and an upper-only
description figure is dropped.

## 2. Decisions

- **D-01 — Interval precedence.** For ranges and single bounds alike: the caller's
  `ExtractSalaryOptions.interval` hint (Spec 5045), then a pay-period token written next to an
  amount, then the magnitude heuristic. `enforceAnnualSalary` keeps its contract (annualised
  amounts, stated interval).
- **D-02 — Contradictions yield nothing.** Two different periods on one range
  (`$20/hr - $40,000/yr`) return the all-`null` envelope rather than a guess.
- **D-03 — `to` needs two currency marks.** The word separator is read only when both amounts
  carry a currency symbol or ISO code (`$100,000 to $150,000`, `45.000 € to 60.000 €`), so prose
  such as `$5 to 10 people` is never a range. The dash keeps its permissive second amount. The
  bare (country-tier) path stays dash-only.
- **D-04 — A data-driven period vocabulary.** One row per interval (English, German, French,
  Spanish, Portuguese, Dutch units and adverbs), after a connector (`/`, `per`, `a`, `an`, `pro`,
  `par`, `por`) or stand-alone (`hourly`, `p.a.`). Single letters other than `h` are excluded
  (`/m` is minute or month); `mon` is excluded because `a Mon-Fri shift` would read as monthly.
- **D-05 — Case-insensitive without the `i` flag.** The range regexes stay case-sensitive for ISO
  codes and `kr`; the vocabulary is expanded to two-case classes instead.
- **D-06 — One owner per whitespace run.** In the extended grammar every run of spaces is matched
  by a single quantifier, so a near-miss stays linear (50 000 spaces: ~3 ms, where the previous
  shape took seconds). Compiled regexes are cached per currency, locale and grammar.
- **D-07 — Keep the earlier behaviour reachable.** `ExtractSalaryOptions.grammar: 'legacy'` (or
  `EVER_JOBS_SALARY_GRAMMAR=legacy` process-wide) restores the earlier range and single-bound
  grammar exactly; `parseCurrency(text, { thousandsSuffix: false })` restores the suffix-blind
  reading; `postProcessCompensation` applies the earlier post-processing rules under the same
  switch. An explicit option beats the variable.
- **D-08 — The post-processing rule is a pure helper.** `postProcessCompensation` in
  `@ever-jobs/common` returns `{ compensation, salarySource }` without mutating its input, so the
  API service becomes a thin call (wiring listed in the plan).
- **D-09 — Scale words guard ranges too.** An amount followed by `million` / `billion` / `mln` /
  `bln` / `trillion` (any case) is not a range bound, as it already was not a single bound.
- **D-10 — A benefit figure never shadows the salary (review fixup, 2026-09-25).** The extended
  grammar scans every range match instead of taking the leftmost. A `to` range whose nearest
  preceding keyword in its clause (at most 80 characters back, a clause ending at `;` `!` `?` `|`
  `•`, a line break or `. `) is a benefit word (`bonus`, `stipend`, `relocation`,
  `reimbursement`, `commission`, `referral`, `budget`, `raised`, `allowance`, `tuition`, `401(k)`,
  `match`, `equity`) is skipped; one with a pay-period token or a salary word (`salary`, `pay`,
  `compensation`, `wage`, `rate`, `base`, `earnings`, `OTE`, ...) is used like a dash range; any
  other `to` range is used only when nothing stronger is in the text. Dash ranges are read exactly
  as before. A single bound whose nearest keyword is a benefit word is skipped too. So `Sign-on
  bonus of $2,000 to $5,000. Base salary $90,000 - $110,000` reads 90,000-110,000, as the legacy
  grammar did.
- **D-11 — The API description fallback needs a cued upper bound (review fixup).**
  `postProcessCompensation` parses the description with `upperBoundNeedsSalaryCue`: an
  upper-only figure counts only with a salary word in its clause and no benefit word there, so
  `relocation assistance up to $10,000` or `401(k) match up to $5,000 per year` never becomes the
  job's salary, while `Compensation: up to $90,000 annually` still does. Lower bounds and ranges
  are unaffected. Plugins calling `extractSalary` directly keep the option off.

## 3. Non-goals

- New currencies (`₹`, `CA$`) and the `between $X and $Y` form.
- A single amount with no directional marker (`$14 per hour`).
- The K-suffix magnitude default (`$20k - $35k`, `OTE $25k - $35k` stay unparsed; `$10K-$20K`
  stays monthly). A data-backed decision of its own.
- The USA-only gate on the description fallback.
- Plugin-local salary regexes; they can move to the shared helper in follow-ups.

## 4. Acceptance

- `parseCurrency` returns `null` for text without digits and for non-finite results, reads `$100K`
  as 100000 and `500 kr` as 500, and with `thousandsSuffix: false` reads `$100K` as 100.
- `convertToAnnual` scales each finite bound, leaves a missing bound missing, is a no-op (returns
  `false`) for a missing, unknown or yearly interval or when no bound is present, normalises
  `HOURLY` / `hour`, and rounds to cents.
- `extractSalary` reads the per-bound, trailing and single-bound token shapes listed in §1 with the
  stated interval, in USD, GBP and EUR, prefix and suffix; rejects conflicting periods and hourly
  ranges above the ceiling; reads `to` ranges with two currency marks; rejects scaled figures.
- Every `extractSalary` "Before" value in §1 is reproduced by `grammar: 'legacy'` and by
  `EVER_JOBS_SALARY_GRAMMAR=legacy`. (`NaN` from `parseCurrency` and the `0` that
  `convertToAnnual` wrote for a missing bound are defects, not behaviour, and are not kept.)
- `postProcessCompensation` annualises single-bound direct salaries, keeps the source of a max-only
  salary, labels an annualised description salary `yearly`, accepts an upper-only description
  figure, lets a description salary replace a compensation with no amount, clears the source of a
  `0` / `0` placeholder, never mutates its input, and reproduces the earlier rules under the legacy
  grammar.
- No existing salary assertion changes except the `from $X to $Y` case, which now reads the full
  range (the legacy grammar keeps the earlier no-match).

## 5. Contracts

```ts
export type SalaryGrammar = 'extended' | 'legacy';
export interface ExtractSalaryOptions { /* … */ grammar?: SalaryGrammar }

export function intervalFromPeriodToken(token: string | null | undefined): CompensationInterval | null;

export interface ParseCurrencyOptions { thousandsSuffix?: boolean }
export function parseCurrency(curStr: string | null | undefined, options?: ParseCurrencyOptions): number | null;

export function convertToAnnual(jobData: {
  interval?: string | null; minAmount?: number | null; maxAmount?: number | null;
}): boolean;

export function hasSalaryAmount(c: { minAmount?: number | null; maxAmount?: number | null } | null | undefined): boolean;

export function postProcessCompensation(input: {
  compensation?: CompensationDto | null;
  description?: string | null;
  country?: Country;              // default USA
  enforceAnnualSalary?: boolean;
  grammar?: SalaryGrammar;
}): { compensation: CompensationDto | null | undefined; salarySource: SalarySource | undefined };
```

Environment: `EVER_JOBS_SALARY_GRAMMAR` = `legacy` | anything else (extended). Read per call.

## 6. Evidence

- 19 short salary field values of the shapes public feeds publish: every value the earlier grammar
  read is unchanged; `$40/hr to $120/hr` and `$15 to $25 per hour` are newly read.
- 72 money-bearing job descriptions from sampled public pages, legacy vs extended: 5 differ, all
  improvements (4 previously lost or truncated ranges now read; 1 page now reports its own stated
  range instead of another employer's card). No description regressed.
- The 36 plugin suites that call the salary helpers plus `apps/api/src/jobs`: 45 suites, all green.
- `helpers.bench.spec.ts`: p95 well under the NFR-1 budget (regexes are now compiled once).
