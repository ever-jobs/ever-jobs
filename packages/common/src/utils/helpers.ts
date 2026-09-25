import {
  CompensationDto,
  CompensationInterval,
  Country,
  JobType,
  SalarySource,
  getCompensationInterval,
  getJobTypeFromString,
  JobTypeLookupOptions,
} from '@ever-jobs/models';

/**
 * Locale dispatch for the Spec 012 salary parser.
 *
 * - `'continental'` — decimal-comma + period-thousands (e.g. `45.000,50`)
 *   used across the Continental EU corpus (DE / FR / ES / IT / NL / PL etc.).
 * - `'anglo'` — decimal-period + comma-thousands (e.g. `45,000.50`)
 *   used across UK / USA / Canada / Australia / NZ etc. The same family
 *   covers Switzerland (with apostrophe-thousands tolerance per FR-12).
 *
 * Spec 012 / § 7.3 documents the full country → locale mapping.
 */
export type SalaryLocale = 'continental' | 'anglo';

/**
 * Result shape returned by {@link parseSalaryCurrency}.
 *
 *   - `code` — ISO 4217 string (`'USD' | 'EUR' | 'GBP' | 'CHF' | 'SEK' |
 *     'NOK' | 'DKK' | 'PLN'`); never null per FR-13.
 *   - `symbol` — the raw character (or short string) detected in the
 *     input that drove the resolution (`'€' | '£' | 'zł' | 'kr' | 'Fr.'`).
 *     `null` when the resolution path was ISO / country / default.
 *   - `confidence` — which detection branch fired:
 *     `'symbol' | 'iso' | 'country' | 'default'`. Roughly equates to
 *     "how strong a signal drove the resolution"; consumers can use it
 *     to gate downstream merge / dedup decisions.
 */
export interface ParseSalaryCurrencyResult {
  readonly code: string;
  readonly symbol: string | null;
  readonly confidence: 'symbol' | 'iso' | 'country' | 'default';
}

/**
 * Spec 012 / § 7.2 — explicit ISO 4217 codes the parser recognises in
 * input text. Order matters here: longer / more specific codes do NOT
 * exist in this set, but a future contributor adding (say) `MXN`
 * should know that the lookup is exact-match against an upper-cased
 * input slice. Map values are the canonical ISO codes returned in
 * {@link ParseSalaryCurrencyResult.code}.
 *
 * Listed alphabetically inside the Map so a `git diff` against a
 * future addition reads cleanly.
 */
const SALARY_ISO_CODES: ReadonlyArray<string> = [
  'CHF', 'DKK', 'EUR', 'GBP', 'NOK', 'PLN', 'SEK', 'USD',
];

/**
 * Spec 012 / § 7.2 — symbol → ISO 4217 lookup. Each entry is
 * unambiguous; the ambiguous shared `'kr'` symbol (SEK / NOK / DKK)
 * lives in {@link SALARY_AMBIGUOUS_SYMBOLS} instead so it can be
 * disambiguated by the country hint.
 *
 * Order is "longest first" so the matcher prefers `'Fr.'` over a
 * stray `'F'` if a future addition introduces one. The match is
 * case-insensitive for `'CHF'` / `'Fr.'` per FR-3.
 */
const SALARY_UNIQUE_SYMBOLS: ReadonlyArray<readonly [string, string]> = [
  ['€', 'EUR'],
  ['£', 'GBP'],
  ['zł', 'PLN'],
  ['Fr.', 'CHF'],
  // Spec 014 / Q-027 / FR-1 — `$` was historically un-registered
  // (USD as the FR-7 default carried it implicitly). The promotion
  // to a `'symbol'`-tier match means an explicit `$` outranks a
  // `country` hint, matching the precedence rule "symbol → ISO →
  // country → default" end-to-end. Appended at END so the iteration
  // order for the other four entries stays byte-identical (FR-5).
  ['$', 'USD'],
];

/**
 * Spec 012 / § 7.2, rule 3 — symbols that map to multiple ISO codes
 * unless a country hint disambiguates. The keys are the raw symbols
 * as they appear in input text; values are the country → ISO mapping
 * the parser uses when an `opts.country` hint is supplied.
 *
 * `'kr'` is the canonical ambiguous case (Sweden / Norway / Denmark
 * all use `kr` — and Iceland uses `kr.` with a trailing period, which
 * we don't currently support). Fallback default = SEK per Q-025.
 */
const SALARY_AMBIGUOUS_SYMBOLS: ReadonlyMap<
  string,
  { readonly fallback: string; readonly byCountry: ReadonlyMap<Country, string> }
> = new Map([
  [
    'kr',
    {
      fallback: 'SEK',
      byCountry: new Map<Country, string>([
        [Country.SWEDEN, 'SEK'],
        [Country.NORWAY, 'NOK'],
        [Country.DENMARK, 'DKK'],
      ]),
    },
  ],
]);

/**
 * Spec 012 / § 7.2, rule 4 — country → primary-currency lookup. Used
 * when neither a symbol nor an explicit ISO code resolves the
 * currency, but the caller passed `opts.country`. Lists only
 * countries whose primary currency is one of the eight ISO codes the
 * parser supports; other countries fall through to the
 * `defaultCode ?? 'USD'` branch.
 */
const SALARY_COUNTRY_TO_CURRENCY: ReadonlyMap<Country, string> = new Map<
  Country,
  string
>([
  // EUR — Eurozone members in `Country` enum
  [Country.AUSTRIA, 'EUR'],
  [Country.BELGIUM, 'EUR'],
  [Country.FINLAND, 'EUR'],
  [Country.FRANCE, 'EUR'],
  [Country.GERMANY, 'EUR'],
  [Country.IRELAND, 'EUR'],
  [Country.ITALY, 'EUR'],
  [Country.LUXEMBOURG, 'EUR'],
  [Country.NETHERLANDS, 'EUR'],
  [Country.PORTUGAL, 'EUR'],
  [Country.SPAIN, 'EUR'],
  // GBP / USD / CHF
  [Country.UK, 'GBP'],
  [Country.USA, 'USD'],
  [Country.SWITZERLAND, 'CHF'],
  // Nordics — distinct currencies
  [Country.SWEDEN, 'SEK'],
  [Country.NORWAY, 'NOK'],
  [Country.DENMARK, 'DKK'],
  // PLN
  [Country.POLAND, 'PLN'],
]);

/**
 * Detect the currency of a salary string.
 *
 * Resolution precedence (Spec 012 / § 7.2):
 *
 *   1. **Explicit ISO code** in the input (`'USD'`, `'EUR'`, …) →
 *      `confidence: 'iso'`.
 *   2. **Unique symbol** (`'€'`, `'£'`, `'zł'`, `'Fr.'`) →
 *      `confidence: 'symbol'`.
 *   3. **Ambiguous symbol** (`'kr'`) — disambiguated by `opts.country`
 *      when supplied → `confidence: 'symbol'`. Without a country hint,
 *      falls back to the symbol's documented default (Q-025: SEK for
 *      `'kr'`) and STILL reports `confidence: 'symbol'` because the
 *      symbol *was* detected.
 *   4. **No symbol, no ISO, country hint present** — pick the
 *      country's primary currency (e.g. `Country.GERMANY` → EUR) →
 *      `confidence: 'country'`.
 *   5. **None of the above** — `defaultCode ?? 'USD'` →
 *      `confidence: 'default'`.
 *
 * The function NEVER throws and NEVER returns `null` for `code` —
 * FR-13 pins this. Callers that need to know whether a meaningful
 * detection happened should inspect `confidence`.
 *
 * @param text — the raw salary string (or any free-form input that
 *               may contain currency hints).
 * @param opts.country — country hint for ambiguous-symbol +
 *               no-currency-found cases.
 * @param opts.defaultCode — override the default `'USD'` fallback.
 *               Useful for plugins that already know they're in a
 *               specific currency context.
 */
export function parseSalaryCurrency(
  text: string | null | undefined,
  opts?: { country?: Country; defaultCode?: string },
): ParseSalaryCurrencyResult {
  const defaultCode = opts?.defaultCode ?? 'USD';
  if (!text) {
    return { code: defaultCode, symbol: null, confidence: 'default' };
  }

  // Rule 1 — explicit ISO 4217 code anywhere in the text. Word-boundary
  // match so we don't catch `'USDJPY'` or a stray `'EUR'` inside an
  // identifier. Case-insensitive per FR-1..FR-5.
  const isoMatch = matchIsoCode(text);
  if (isoMatch) {
    return { code: isoMatch, symbol: null, confidence: 'iso' };
  }

  // Rule 2 — unique symbol. Order-preserved iteration so the longest
  // shapes (`'Fr.'` is two chars + a period) win over single-char
  // symbols if they happen to overlap in a future addition.
  for (const [symbol, code] of SALARY_UNIQUE_SYMBOLS) {
    if (text.includes(symbol) || text.toLowerCase().includes(symbol.toLowerCase())) {
      return { code, symbol, confidence: 'symbol' };
    }
  }

  // Rule 3 — ambiguous symbol. We only check for the documented set
  // (`'kr'` today). Match against the lower-cased input so `'Kr'` /
  // `'KR'` / `'kr'` all hit. Disambiguate by `opts.country` when
  // present; otherwise use the documented fallback (Q-025: SEK).
  const lowered = text.toLowerCase();
  for (const [symbol, ambiguous] of SALARY_AMBIGUOUS_SYMBOLS.entries()) {
    if (lowered.includes(symbol.toLowerCase())) {
      const fromCountry = opts?.country
        ? ambiguous.byCountry.get(opts.country)
        : undefined;
      return {
        code: fromCountry ?? ambiguous.fallback,
        symbol,
        confidence: 'symbol',
      };
    }
  }

  // Rule 4 — country fallback when no in-text signal resolved.
  if (opts?.country) {
    const fromCountry = SALARY_COUNTRY_TO_CURRENCY.get(opts.country);
    if (fromCountry) {
      return { code: fromCountry, symbol: null, confidence: 'country' };
    }
  }

  // Rule 5 — global default.
  return { code: defaultCode, symbol: null, confidence: 'default' };
}

/**
 * Internal helper — match an ISO 4217 code in `text` with a strict
 * word boundary on each side. Returns the canonical (upper-cased)
 * code on a hit, or `null`. Pulled into a function so the loop in
 * {@link parseSalaryCurrency} stays readable and so a future spec
 * extending the supported ISO set has one place to amend.
 */
function matchIsoCode(text: string): string | null {
  const upper = text.toUpperCase();
  for (const code of SALARY_ISO_CODES) {
    // `\b...\b` won't anchor against punctuation like `'EUR.'`, so we
    // lean on a manual char-class check on the surrounding chars
    // instead. `RegExp` is overkill for an 8-element exact-match set.
    const idx = upper.indexOf(code);
    if (idx === -1) continue;
    const before = idx === 0 ? '' : upper[idx - 1];
    const after = idx + code.length >= upper.length ? '' : upper[idx + code.length];
    if (isWordChar(before) || isWordChar(after)) continue;
    return code;
  }
  return null;
}

/** Word-character test for the ISO-code boundary check. */
function isWordChar(ch: string): boolean {
  return /[A-Z0-9_]/.test(ch);
}

/**
 * Spec 012 / § 7.3 — country → locale dispatch table for {@link pickLocale}.
 *
 * Continental rows use decimal-comma + period-thousands (`45.000,50`);
 * anglo rows use decimal-period + comma-thousands (`45,000.50`).
 * Switzerland intentionally lands on `'anglo'` and relies on the
 * apostrophe-thousands tolerance baked into {@link parseSalaryNumber}
 * (see Spec 012 / Notes-for-the-next-run decision 2 — a third
 * `'swiss'` locale was rejected as over-engineering for one edge).
 *
 * Countries not listed fall through to the documented `'anglo'`
 * default (see {@link pickLocale}). Adding a new country is the only
 * place to amend; both helpers branch off this single table.
 */
const SALARY_LOCALE_MAP: ReadonlyMap<Country, SalaryLocale> = new Map<
  Country,
  SalaryLocale
>([
  // Continental EU + extended (Spec 012 / § 7.3 row 1).
  [Country.AUSTRIA, 'continental'],
  [Country.BELGIUM, 'continental'],
  [Country.CZECHREPUBLIC, 'continental'],
  [Country.DENMARK, 'continental'],
  [Country.FINLAND, 'continental'],
  [Country.FRANCE, 'continental'],
  [Country.GERMANY, 'continental'],
  [Country.HUNGARY, 'continental'],
  [Country.IRELAND, 'continental'],
  [Country.ITALY, 'continental'],
  [Country.LUXEMBOURG, 'continental'],
  [Country.NETHERLANDS, 'continental'],
  [Country.NORWAY, 'continental'],
  [Country.POLAND, 'continental'],
  [Country.PORTUGAL, 'continental'],
  [Country.ROMANIA, 'continental'],
  [Country.SPAIN, 'continental'],
  [Country.SWEDEN, 'continental'],
  // Anglosphere (Spec 012 / § 7.3 row 2).
  [Country.AUSTRALIA, 'anglo'],
  [Country.CANADA, 'anglo'],
  [Country.HONGKONG, 'anglo'],
  [Country.INDIA, 'anglo'],
  [Country.MALAYSIA, 'anglo'],
  [Country.NEWZEALAND, 'anglo'],
  [Country.PHILIPPINES, 'anglo'],
  [Country.SINGAPORE, 'anglo'],
  [Country.SOUTHAFRICA, 'anglo'],
  [Country.UK, 'anglo'],
  [Country.USA, 'anglo'],
  // Switzerland — anglo with apostrophe-thousands tolerance
  // (Spec 012 / § 7.3 row 3 + Notes-for-the-next-run decision 2).
  [Country.SWITZERLAND, 'anglo'],
]);

/**
 * Pick the {@link SalaryLocale} for a given `country` hint.
 *
 *   - Maps Continental EU + extended → `'continental'`.
 *   - Maps Anglosphere + Switzerland → `'anglo'`.
 *   - `undefined` (no hint) → `'anglo'` (preserves existing USD
 *     behaviour byte-for-byte; Spec 012 / § 7.3 row 4).
 *   - Any unmapped country (e.g. JAPAN, BRAZIL) → `'anglo'` default.
 *
 * Module-private per Spec 012 / Notes-for-the-next-run decision 1
 * ("`pickLocale` stays private"); consumers should pass `country`
 * to {@link parseSalaryNumber} via the eventual `extractSalary()`
 * dispatcher (Spec 012 / T03) rather than calling this directly.
 *
 * Re-exported solely through {@link __INTERNAL_TEST_ONLY__} so the
 * acceptance cases listed in tasks.md (Phase 2 / T02) can be pinned.
 */
function pickLocale(country: Country | undefined): SalaryLocale {
  if (country === undefined) return 'anglo';
  return SALARY_LOCALE_MAP.get(country) ?? 'anglo';
}

/**
 * Spec 012 / § 7.3 — locale-aware numeric parser. Strips
 * locale-appropriate thousands separators, normalises the decimal
 * separator to `'.'`, and returns a JavaScript `number`.
 *
 * Locale dispatch (FR-6, FR-9, FR-12):
 *
 *   - **`'continental'`** — decimal `,`, thousands `.` or U+00A0.
 *     Examples: `'45.000'` → `45000`; `'1 234,56'` → `1234.56`;
 *     `'1.234.567,89'` → `1234567.89`.
 *   - **`'anglo'`** — decimal `.`, thousands `,` or U+00A0.
 *     Examples: `'45,000.50'` → `45000.50`; `'1,234,567.89'` →
 *     `1234567.89`.
 *
 * Both locales tolerate the Swiss apostrophe-thousands convention
 * (`"90'000"` → `90000`) per FR-12 — the apostrophe is stripped
 * up-front before either branch runs, so it never collides with
 * the decimal separator.
 *
 * Returns `null` (NEVER throws) for any input that isn't parseable
 * as a number under the chosen locale: empty string, non-numeric
 * text, or a string with multiple decimal separators / mismatched
 * separator pattern.
 *
 * Bench target (NFR-1): ≤ 0.5 ms p95 on a 200-char input. Pure
 * `String.prototype.replace` + one `parseFloat`; no `RegExp`
 * compilation per call (the validating regex literals are compiled
 * once at module-load).
 *
 * @param raw    — the raw numeric substring (typically already
 *                 plucked out of a wider salary string by the
 *                 dispatcher in {@link extractSalary}).
 * @param locale — `'continental'` or `'anglo'`. Use {@link pickLocale}
 *                 (private) or pass through from the caller's
 *                 explicit `Country` hint.
 */
export function parseSalaryNumber(
  raw: string | null | undefined,
  locale: SalaryLocale,
): number | null {
  if (raw === null || raw === undefined) return null;

  // Up-front normalisation applied to both locales:
  //   - U+00A0 (non-breaking space) → regular space, so the same
  //     `' '` strip handles both.
  //   - Swiss thousands apostrophe → empty, per FR-12.
  //   - Trim outer whitespace.
  let s = String(raw).replace(/ /g, ' ').replace(/'/g, '').trim();
  if (!s) return null;

  // Reject anything that isn't a digit / `.` / `,` / space / leading
  // sign before doing the locale-specific replace pass. Cheap regex
  // bail-out — keeps the hot path on parseable inputs.
  if (!SALARY_NUMBER_PRE_PATTERN.test(s)) return null;

  if (locale === 'continental') {
    // Continental: `.` and ` ` are thousands; `,` is the decimal.
    s = s.replace(/[. ]/g, '').replace(',', '.');
  } else {
    // Anglo: `,` and ` ` are thousands; `.` is the decimal.
    s = s.replace(/[, ]/g, '');
  }

  // Final numeric validation — exactly one optional decimal, optional
  // sign, all digits otherwise. Catches stray double-decimals like
  // `'45.000.50'` parsed under `'anglo'`.
  if (!SALARY_NUMBER_POST_PATTERN.test(s)) return null;

  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Pre-strip validating regex for {@link parseSalaryNumber}. Allows
 * a leading sign, digits, `.`, `,`, and ASCII space (U+00A0 has
 * already been normalised by the time we reach this check).
 */
const SALARY_NUMBER_PRE_PATTERN = /^-?[\d., ]+$/;

/**
 * Post-strip validating regex for {@link parseSalaryNumber}. After
 * the locale-specific replace pass, the result MUST be a clean
 * `[-]digits[.digits]` shape — anything else (multiple decimals,
 * trailing punctuation) means the input wasn't a real number.
 */
const SALARY_NUMBER_POST_PATTERN = /^-?\d+(\.\d+)?$/;

/**
 * @internal — single test-shim symbol so the unit-test suite can
 * pin the {@link pickLocale} acceptance cases listed in
 * `.specify/specs/012-european-salary-parser/tasks.md` (Phase 2 /
 * T02) without exporting the helper at the public package barrel.
 *
 * Production code MUST NOT consume this object. The symbol name
 * (`__INTERNAL_TEST_ONLY__`) plus the leading-double-underscore
 * convention should make stray imports easy to spot in code review.
 *
 * Why a shim instead of a normal `export`? Spec 012's
 * Notes-for-the-next-run decision 1 keeps `pickLocale` "private"
 * for the same reason T01's `matchIsoCode` / `isWordChar` are
 * private — it's an implementation detail of the eventual
 * `extractSalary()` dispatcher (Spec 012 / T03). Exposing it via
 * a clearly-flagged shim preserves that intent while still giving
 * the test suite a way to anchor the acceptance assertions.
 */
export const __INTERNAL_TEST_ONLY__ = Object.freeze({ pickLocale });

/**
 * Extract email addresses from text.
 * Replaces Python's extract_emails_from_text().
 */
export function extractEmails(text: string | null): string[] | null {
  if (!text) return null;
  const regex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const matches = text.match(regex);
  return matches && matches.length > 0 ? matches : null;
}

/**
 * Spec 012 / T03 — `extractSalary` options.
 *
 * Existing fields (`lowerLimit / upperLimit / hourlyThreshold /
 * monthlyThreshold / enforceAnnualSalary`) preserve the pre-Spec-012
 * behaviour byte-for-byte. New fields (`country / locale /
 * defaultCurrency`) drive the multi-currency dispatcher; all are
 * optional and default to the existing USD / anglo path when unset.
 */
export interface ExtractSalaryOptions {
  lowerLimit?: number;
  upperLimit?: number;
  hourlyThreshold?: number;
  monthlyThreshold?: number;
  enforceAnnualSalary?: boolean;
  /**
   * Spec 5045 — explicit pay period for the parsed range. When set, the
   * interval is taken from this hint instead of being guessed from the
   * amount's magnitude, and the range is annualized with the period's factor
   * for the bounds check. Callers that know the unit (e.g. a `"$35/hr"` token
   * parsed from the source) pass it so an authoritative signal is never lost
   * to the magnitude heuristic (`$28,000/yr` → yearly, not monthly;
   * `$1,200/wk` → weekly, which magnitude cannot represent at all).
   */
  interval?: CompensationInterval;
  /** Spec 012 / T03 — country hint for currency / locale resolution. */
  country?: Country;
  /**
   * Spec 012 / T03 — explicit locale override; takes precedence over
   * `country`-derived locale when both are set.
   */
  locale?: SalaryLocale;
  /**
   * Spec 012 / T03 — fallback ISO 4217 code when neither symbol nor
   * ISO nor country resolves a currency. Defaults to `'USD'` per
   * Spec 012 / FR-7.
   */
  defaultCurrency?: string;
  /**
   * Spec 1695 — range / single-bound grammar for this call. Unset takes the
   * process-wide default from `EVER_JOBS_SALARY_GRAMMAR` (`extended` unless
   * that variable is `legacy`). See {@link SalaryGrammar}.
   */
  grammar?: SalaryGrammar;
  /**
   * Spec 1695 — accept an upper-only figure (`"up to $90,000"`) only when a
   * salary word (`salary`, `pay`, `compensation`, `wage`, `rate`, `base`, …)
   * sits in the same clause before it and no benefit word (`bonus`,
   * `stipend`, `relocation`, `401(k)`, `tuition`, …) does. Default `false`.
   * {@link postProcessCompensation} sets it for its whole-description
   * fallback, where "up to $10,000 relocation assistance" is far more common
   * than an upper-only salary.
   */
  upperBoundNeedsSalaryCue?: boolean;
}

/**
 * Spec 1695 — which salary grammar {@link extractSalary} applies.
 *
 * - `'extended'` (default) — reads a pay-period token written next to either
 *   amount (`"$20/hr - $25/hr"`, `"$28,000 - $32,000/yr"`,
 *   `"up to $4,000/mo"`, `"45.000 €/Jahr"`) and takes the interval from it
 *   instead of the magnitude heuristic; accepts the word `to` between two
 *   currency-marked amounts (`"$100,000 to $150,000"`); and never reads an
 *   amount followed by a scale word (`"$5 - $10 million"`) as a range.
 *   A `to` range or a single bound whose nearest preceding keyword in its
 *   clause is a benefit word (`"Sign-on bonus of $2,000 to $5,000"`,
 *   `"relocation up to $10,000"`) is never read as the salary, and a `to`
 *   range with neither a pay-period token nor a salary word before it is
 *   used only when no dash range or qualified `to` range exists in the text.
 * - `'legacy'` — the grammar before Spec 1695: dash separators only, no
 *   pay-period tokens (a token after the first amount breaks the match, one
 *   after the second is ignored), interval from magnitude unless
 *   {@link ExtractSalaryOptions.interval} is set.
 */
export type SalaryGrammar = 'extended' | 'legacy';

/** Environment variable holding the process-wide default {@link SalaryGrammar}. */
const SALARY_GRAMMAR_ENV = 'EVER_JOBS_SALARY_GRAMMAR';

/**
 * Resolve the grammar for one call: an explicit option wins; otherwise
 * `EVER_JOBS_SALARY_GRAMMAR=legacy` selects the legacy grammar and anything
 * else (unset, empty, unknown) the extended one. Read per call, so the switch
 * needs no restart-time cache.
 */
function resolveSalaryGrammar(option: SalaryGrammar | undefined): SalaryGrammar {
  if (option === 'extended' || option === 'legacy') return option;
  const raw = process.env[SALARY_GRAMMAR_ENV]?.trim().toLowerCase();
  return raw === 'legacy' ? 'legacy' : 'extended';
}

/**
 * Spec 012 / T03 — `extractSalary` result envelope. Shape unchanged
 * from the original (FR-10), now exported as a public type so plugin
 * authors can write `Promise<ExtractSalaryResult>`-typed adapters.
 */
export interface ExtractSalaryResult {
  interval: string | null;
  minAmount: number | null;
  maxAmount: number | null;
  currency: string | null;
}

/**
 * Per-currency regex token alternation (used to build the salary
 * matcher). Each entry is a regex-escaped alternation of the
 * recognised symbols / ISO codes for that currency. Order matters
 * within an alternation: longer / more specific shapes (e.g.
 * `'EUR'` over `'€'`) come first so the engine prefers them when
 * both are present.
 *
 * The leading `\\b` on multi-letter ISO codes prevents `'EUR'` from
 * matching inside `'EURO'` etc. The single-character symbols don't
 * need a word boundary.
 */
const SALARY_SYMBOL_ALTERNATIONS: ReadonlyMap<string, string> = new Map([
  ['USD', '\\$|\\bUSD\\b'],
  ['EUR', '€|\\bEUR\\b'],
  ['GBP', '£|\\bGBP\\b'],
  ['CHF', '\\bCHF\\b|\\bFr\\.?'],
  ['SEK', '\\bSEK\\b|\\bkr\\b'],
  ['NOK', '\\bNOK\\b|\\bkr\\b'],
  ['DKK', '\\bDKK\\b|\\bkr\\b'],
  ['PLN', 'zł|\\bPLN\\b'],
]);

/**
 * Per-locale regex source for a salary number. The continental and
 * anglo shapes flip thousands / decimal separators; both tolerate
 * U+00A0 thousands.
 *
 * Spec 014 / T02 (Q-027 part 2) — the `anglo` shape now also tolerates
 * the Swiss apostrophe (`'`) as a thousands separator, so literal Swiss
 * inputs like `"CHF 90'000"` match the regex directly. The continental
 * shape is intentionally unchanged: a continental dual-decimal like
 * `"45'000,50"` would otherwise mis-classify the `'` as a thousands
 * separator and lose the trailing decimal. Both locales additionally
 * strip `'` up-front in {@link parseSalaryNumber} (FR-9 / FR-12) as a
 * defence-in-depth path — the regex tolerance and the post-capture
 * strip are both load-bearing: the regex tolerance lets the dispatcher
 * span apostrophe-grouped digits in the FIRST place; the post-capture
 * strip survives the per-locale separator collapse.
 */
const SALARY_NUMBER_REGEX_SRC: Readonly<Record<SalaryLocale, string>> = {
  continental: '\\d+(?:[.\\u00A0]\\d{3})*(?:,\\d+)?',
  anglo: "\\d+(?:[,\\u00A0']\\d{3})*(?:\\.\\d+)?",
};

/**
 * Spec 012 / T03 — currency → "natural" locale mapping. Used as the
 * third tier in {@link resolveSalaryLocale}'s cascade (after explicit
 * `options.locale` and `options.country`). Mirrors the
 * country → locale mapping in {@link SALARY_LOCALE_MAP}: USD / GBP /
 * CHF use `'anglo'`; everything else uses `'continental'`. Without
 * this tier, an EUR-labelled input with no country hint would be
 * parsed as anglo (period-decimal) and `'45.000 €'` would yield
 * 45.0 instead of 45000.
 */
const CURRENCY_TO_NATURAL_LOCALE: ReadonlyMap<string, SalaryLocale> = new Map([
  ['USD', 'anglo'],
  ['GBP', 'anglo'],
  ['CHF', 'anglo'],
  ['EUR', 'continental'],
  ['SEK', 'continental'],
  ['NOK', 'continental'],
  ['DKK', 'continental'],
  ['PLN', 'continental'],
]);

/**
 * Resolve the {@link SalaryLocale} for a single `extractSalary`
 * call. Cascade:
 *
 *   1. Explicit `options.locale` — operator told us directly.
 *   2. **Spec 015 / Q-035 / FR-1 — symbol-tier anglo short-circuit.**
 *      When the currency was resolved by a unique symbol AND the
 *      currency's natural locale is `'anglo'` (USD / GBP / CHF),
 *      lift the FR-1 precedence rule "symbol > country" from
 *      currency-only to currency-AND-locale: return `'anglo'`
 *      directly, bypassing the country tier. This rescues the
 *      `"$100,000 - $150,000" + country=GERMANY` case (Spec 012 /
 *      § 8 case 14) where the prior cascade picked Germany's
 *      continental locale and mis-parsed `100,000` as `100`.
 *
 *      The short-circuit is **anglo-only by design** (see Spec 015
 *      / § 10 Decisions log entry "narrowing rationale"). For
 *      symbol-tier continental currencies (EUR / SEK / NOK / DKK /
 *      PLN), the country tier is preserved because anglo-shape
 *      input strings (e.g. `"€45,000 - €60,000" + country=USA`)
 *      would mis-parse under the continental regex. The asymmetric
 *      narrowing reflects the asymmetric character class semantics
 *      of the two regexes: anglo accepts `,` / ` ` / `'`
 *      thousands, while continental treats `,` as the decimal
 *      separator.
 *   3. `options.country` → `pickLocale(country)` — country hint
 *      drives the locale.
 *   4. Detected `currency` → natural locale via
 *      {@link CURRENCY_TO_NATURAL_LOCALE} — preserves intent when
 *      neither operator hint is supplied (e.g. a `'45.000 €'` ad
 *      should be parsed continental even without a country).
 *   5. `'anglo'` default (preserves USD byte-for-byte behaviour;
 *      Spec 012 / FR-10).
 */
function resolveSalaryLocale(
  options: ExtractSalaryOptions | undefined,
  currency: string,
  confidence: ParseSalaryCurrencyResult['confidence'],
): SalaryLocale {
  if (options?.locale) return options.locale;
  if (confidence === 'symbol') {
    const naturalLocale = CURRENCY_TO_NATURAL_LOCALE.get(currency);
    if (naturalLocale === 'anglo') return 'anglo';
  }
  if (options?.country !== undefined) return pickLocale(options.country);
  return CURRENCY_TO_NATURAL_LOCALE.get(currency) ?? 'anglo';
}

/**
 * Spec 1695 — make a regex source case-insensitive without the `i` flag.
 * The range matchers must stay case-sensitive (ISO codes, `kr`, `Fr.`), so
 * each letter is rewritten as a two-case class (`hr` → `[hH][rR]`). Escape
 * sequences (`\s`, `\.`, `\b`) are copied unchanged, and so is any letter
 * without a single-character counterpart in the other case.
 */
function caseInsensitiveSrc(src: string): string {
  return src.replace(/\\.|[A-Za-z\u00C0-\u024F]/g, (ch) => {
    if (ch.length === 2) return ch;
    const lower = ch.toLowerCase();
    const upper = ch.toUpperCase();
    if (lower === upper || lower.length !== 1 || upper.length !== 1) return ch;
    return `[${lower}${upper}]`;
  });
}

/**
 * Spec 1695 — pay-period words that may follow a salary amount after a
 * connector (`/`, `per`, `a`, `an`, `pro`, `par`, `por`): `"$20/hr"`,
 * `"$53,000/yr"`, `"£30,000 per annum"`, `"$25 an hour"`, `"45.000 €/Jahr"`,
 * `"3.000 € par mois"`. One row per interval, so a language is a one-line
 * addition. Single letters other than `h` are left out on purpose (`/m`
 * could be minute or month; `/d` and `/a` are ambiguous), and so is `mon`,
 * which reads a weekday (`"a Mon-Fri shift"`) as a month.
 */
const SALARY_PERIOD_UNITS: ReadonlyArray<readonly [CompensationInterval, string]> = [
  [CompensationInterval.HOURLY, 'hours|hour|hrs|hr|h|stunde|std|heure|hora|uur'],
  [CompensationInterval.DAILY, 'days|day|tag|jour|día|dia|dag'],
  [CompensationInterval.WEEKLY, 'weeks|week|wks|wk|woche|semaine|semana'],
  [CompensationInterval.MONTHLY, 'months|month|mths|mth|mos|mo|monat|mois|mes|maand'],
  [CompensationInterval.YEARLY, 'years|year|yrs|yr|annum|anno|jahr|année|an|año|ano|jaar'],
];

/** Spec 1695 — stand-alone period words that need no connector (`"$20 - $25 hourly"`). */
const SALARY_PERIOD_ADVERBS: ReadonlyArray<readonly [CompensationInterval, string]> = [
  [CompensationInterval.HOURLY, 'hourly|p\\.?h\\.?'],
  [CompensationInterval.DAILY, 'daily'],
  [CompensationInterval.WEEKLY, 'weekly'],
  [CompensationInterval.MONTHLY, 'monthly|monatlich|mensuel'],
  [CompensationInterval.YEARLY, 'yearly|annually|annual|jährlich|annuel|p\\.?a\\.?'],
];

/** Connectors between an amount and a period word (the `/` form is separate). */
const SALARY_PERIOD_CONNECTORS = 'per|an|a|pro|par|por';

/**
 * A period word must end the token: the next character may not be a letter.
 * ASCII `\b` is not enough — it treats `é` / `ñ` as a word boundary.
 */
const SALARY_PERIOD_END = '(?![A-Za-z\\u00C0-\\u024F])';

/**
 * Spec 1695 — regex source of the optional pay-period token that may follow
 * ONE salary amount (or its trailing currency symbol). Alternations of
 * literals only (no nested quantifiers), with a top-level `|`, so a builder
 * always wraps it in a group.
 *
 * It carries no leading whitespace on purpose: each builder puts exactly one
 * `\s*` in front of it and one after it, so a run of spaces is always owned
 * by a single quantifier. Two `\s*` competing for the same run make a
 * failing match quadratic in the run's length.
 */
const SALARY_PERIOD_TOKEN_SRC =
  `(?:\\/\\s*|\\b${caseInsensitiveSrc(`(?:${SALARY_PERIOD_CONNECTORS})`)}\\s+)` +
  `${caseInsensitiveSrc(`(?:${SALARY_PERIOD_UNITS.map(([, alt]) => alt).join('|')})`)}` +
  `${SALARY_PERIOD_END}` +
  `|\\b${caseInsensitiveSrc(`(?:${SALARY_PERIOD_ADVERBS.map(([, alt]) => alt).join('|')})`)}` +
  `${SALARY_PERIOD_END}`;

/** Spec 1695 — the word range separator (`"$100,000 to $150,000"`). */
const SALARY_WORD_SEPARATOR_SRC = `\\b${caseInsensitiveSrc('to')}\\b`;

/**
 * Spec 1695 — words that mark a nearby amount as something other than the
 * job's pay: a bonus, stipend, relocation or tuition budget, a commission, a
 * referral reward, a retirement match, money a company raised.
 */
const SALARY_BENEFIT_WORDS_SRC =
  'bonus(?:es)?|stipends?|relocation|reimburse\\w*|commissions?|referrals?|budgets?|' +
  'raised|allowances?|tuition|401\\s*\\(?k\\)?|match(?:ing)?|equity';

/** Spec 1695 — words that mark a nearby amount as the job's pay. */
const SALARY_CUE_WORDS_SRC =
  'salary|salaries|pay|paid|paying|compensation|comp|wages?|rates?|base|' +
  'earn(?:s|ings?)?|income|ote|remuneration|gehalt|salaire|salario|sueldo';

/** Keyword scanner; `matchAll` clones it, so the shared instance keeps no state. */
const SALARY_CONTEXT_WORDS = new RegExp(
  `(?<![A-Za-z0-9])(?:(?<benefit>${SALARY_BENEFIT_WORDS_SRC})|(?<cue>${SALARY_CUE_WORDS_SRC}))(?![A-Za-z])`,
  'gi',
);

/**
 * A clause ends at `;` `!` `?` `|` `•`, a line break, or a period followed by
 * whitespace (so the `.` inside `"$1,000.50"` or `"45.000 €"` does not count).
 * A colon does not end one: `"Salary: $95,000"` keeps its cue.
 */
const SALARY_CLAUSE_BREAK = /[;!?|•\n\r]|\.(?=\s)/g;

/** How far back from an amount {@link salaryContextBefore} looks for a keyword. */
const SALARY_CONTEXT_WINDOW = 80;

/**
 * Spec 1695 — what the words before an amount say about it, within its clause
 * and at most {@link SALARY_CONTEXT_WINDOW} characters back: the class of the
 * NEAREST keyword (`"bonus, and the salary is $X"` → `salary`), plus whether
 * any cue / benefit word appears at all.
 */
interface SalaryContext {
  nearest: 'benefit' | 'salary' | 'none';
  hasCue: boolean;
  hasBenefit: boolean;
}

function salaryContextBefore(text: string, index: number): SalaryContext {
  let start = Math.max(0, index - SALARY_CONTEXT_WINDOW);
  // Never start inside a word: a cut "database" must not read as "base".
  while (start > 0 && start < index && /[A-Za-z0-9]/.test(text[start - 1])) start++;
  let clause = text.slice(start, index);
  let clauseStart = 0;
  for (const found of clause.matchAll(SALARY_CLAUSE_BREAK)) {
    clauseStart = (found.index ?? 0) + found[0].length;
  }
  clause = clause.slice(clauseStart);

  const context: SalaryContext = { nearest: 'none', hasCue: false, hasBenefit: false };
  for (const found of clause.matchAll(SALARY_CONTEXT_WORDS)) {
    if (found.groups?.benefit) {
      context.nearest = 'benefit';
      context.hasBenefit = true;
    } else {
      context.nearest = 'salary';
      context.hasCue = true;
    }
  }
  return context;
}

/** One range match the extended grammar may use, and how strongly it reads as pay. */
interface RangeCandidate {
  match: RegExpExecArray;
  /** `true` for a dash range, or a `to` range with a period token or a salary word. */
  strong: boolean;
}

/**
 * Spec 1695 — pick the range to read from a text in the extended grammar.
 * Scans every match of `pattern` (a global copy of a range regex) left to
 * right:
 *
 * - a dash range is used as soon as it is found, as in the legacy grammar;
 * - a `to` range whose nearest preceding keyword is a benefit word
 *   (`"Sign-on bonus of $2,000 to $5,000"`) is skipped;
 * - a `to` range with a pay-period token or a salary word before it is used
 *   like a dash range;
 * - any other `to` range (`"$100,000 to $150,000"` with nothing around it)
 *   is kept as a weak fallback, returned only when nothing stronger follows.
 *
 * After a skipped match the scan resumes one character later, so a range
 * overlapping the skipped one is still found.
 */
function selectRangeMatch(text: string, pattern: RegExp): RangeCandidate | null {
  let weak: RegExpExecArray | null = null;
  pattern.lastIndex = 0;
  for (let found = pattern.exec(text); found !== null; found = pattern.exec(text)) {
    if (found.groups?.to === undefined) return { match: found, strong: true };
    const context = salaryContextBefore(text, found.index);
    if (context.nearest !== 'benefit') {
      if (context.nearest === 'salary' || found.groups.minPer || found.groups.maxPer) {
        return { match: found, strong: true };
      }
      weak ??= found;
    }
    pattern.lastIndex = found.index + 1;
  }
  return weak ? { match: weak, strong: false } : null;
}

/** Per-interval classifiers for a captured token, in {@link SALARY_PERIOD_UNITS} order. */
const SALARY_PERIOD_CLASSIFIERS: ReadonlyArray<readonly [CompensationInterval, RegExp]> =
  SALARY_PERIOD_UNITS.map(([interval, units]) => {
    const adverbs = SALARY_PERIOD_ADVERBS.find(([candidate]) => candidate === interval)?.[1];
    return [
      interval,
      new RegExp(
        `^(?:(?:\\/|${SALARY_PERIOD_CONNECTORS})\\s*)?(?:${units})$` +
          (adverbs ? `|^(?:${adverbs})$` : ''),
        'i',
      ),
    ] as const;
  });

/**
 * Spec 1695 — map a pay-period token (`"/hr"`, `" per annum"`, `"hourly"`,
 * `"p.a."`, `"/Jahr"`) to its {@link CompensationInterval}. Also accepts a
 * bare unit (`"hr"`, `"year"`) and anything {@link getCompensationInterval}
 * understands, so a plugin reading a separate "pay period" field can reuse
 * it. Returns `null` for an absent or unknown token (`" per shift"`, `"/m"`).
 */
export function intervalFromPeriodToken(
  token: string | null | undefined,
): CompensationInterval | null {
  if (!token) return null;
  const text = token.trim().replace(/\s+/g, ' ').replace(/^\/\s*/, '/');
  if (!text) return null;
  for (const [interval, classifier] of SALARY_PERIOD_CLASSIFIERS) {
    if (classifier.test(text)) return interval;
  }
  return getCompensationInterval(text);
}

/**
 * Spec 1695 — the interval stated by the per-bound tokens of one range
 * match. Either bound's token applies to the whole range; two DIFFERENT
 * periods (`"$20/hr - $40,000/yr"`) make the match unusable (`'conflict'`)
 * rather than a guess.
 */
function periodFromTokens(
  minToken: string | undefined,
  maxToken: string | undefined,
): CompensationInterval | null | 'conflict' {
  const fromMin = intervalFromPeriodToken(minToken);
  const fromMax = intervalFromPeriodToken(maxToken);
  if (fromMin && fromMax && fromMin !== fromMax) return 'conflict';
  return fromMax ?? fromMin;
}

/**
 * Spec 1695 — the three range regexes are built from a handful of inputs
 * (currency alternation × locale number shape × grammar), so each distinct
 * one is compiled once and reused. The plain ones carry no `g` / `y` flag, so
 * a shared instance holds no `lastIndex` state between calls; the global
 * copies the extended grammar scans with are reset by {@link selectRangeMatch}
 * before every use (the scan is synchronous, so no two calls interleave).
 */
const SALARY_REGEX_CACHE = new Map<string, RegExp>();

function cachedSalaryRegex(key: string, build: () => RegExp): RegExp {
  let regex = SALARY_REGEX_CACHE.get(key);
  if (!regex) {
    regex = build();
    SALARY_REGEX_CACHE.set(key, regex);
  }
  return regex;
}

/**
 * Build the prefix-anchored salary regex: the FIRST number must be
 * preceded by a currency symbol or ISO code. Named groups — `min` /
 * `max` (raw numbers), `minK` / `maxK` (K suffix) and, in the extended
 * grammar, `minPer` / `maxPer` (pay-period tokens) and `to` (set when the word
 * separator was used; read by {@link selectRangeMatch}), Spec 1695. Form:
 *
 *   legacy:   <sym>\s*<num>K?\s*[<sym>?]\s*<dash>\s*[<sym>?]<num>K?[\s<sym>?]
 *   extended: <sym>\s*<num>K?\s*[<sym>\s*][<per>\s*]<dash|to>\s*[<sym>\s*]<num>K?\s*[<sym>\s*][+\s*][<per>]
 *
 * Matches USD `$100,000 - $150,000`, GBP `£45,000 - £60,000`, CHF
 * `CHF 90,000 - 120,000`, `$20/hr - $25/hr`, etc. Permissive on the
 * second number after a dash: its left-hand symbol is optional (covers
 * `$100 - 150`-style shorthand). The extended grammar's word separator
 * `to` requires that symbol, so plain prose (`"$5 to 10 people"`) is not
 * read as a range, and neither amount may be followed by a scale word.
 */
function buildSalaryRegexPrefix(
  symbolAlt: string,
  numSrc: string,
  grammar: SalaryGrammar = 'extended',
): RegExp {
  // The `[kK]?\b` shape pins the K-suffix to a word boundary so
  // `100K -` parses cleanly while `100 kr` doesn't lose the leading
  // `k` to the suffix capture group. Without the boundary, the
  // `k` of `kr` would be greedily consumed by `([kK]?)` and the
  // currency symbol matcher would then see only `r` (Spec 012 / T03
  // — debugged in run #40 against `'500.000 kr - 700.000 kr'`).
  if (grammar === 'legacy') {
    return new RegExp(
      `(?:${symbolAlt})\\s*(?<min>${numSrc})\\s*(?<minK>[kK]?\\b)\\s*(?:${symbolAlt})?` +
        `\\s*[-–—]\\s*` +
        `(?:${symbolAlt})?\\s*(?<max>${numSrc})\\s*(?<maxK>[kK]?\\b)\\s*(?:${symbolAlt})?`,
    );
  }
  // Spec 1695 — every whitespace run has exactly one owner (see
  // SALARY_PERIOD_TOKEN_SRC), so a near-miss on a long run stays linear.
  const scale = SALARY_RANGE_SCALE_LOOKAHEAD;
  return new RegExp(
    `(?:${symbolAlt})\\s*(?<min>${numSrc})\\s*(?<minK>[kK]?\\b)${scale}` +
      `\\s*(?:(?:${symbolAlt})\\s*)?` +
      `(?:(?<minPer>${SALARY_PERIOD_TOKEN_SRC})\\s*)?` +
      `(?:[-–—]\\s*(?:(?:${symbolAlt})\\s*)?|(?<to>${SALARY_WORD_SEPARATOR_SRC})\\s*(?:${symbolAlt})\\s*)` +
      `(?<max>${numSrc})\\s*(?<maxK>[kK]?\\b)${scale}` +
      `\\s*(?:(?:${symbolAlt})\\s*)?(?:\\+\\s*)?` +
      `(?<maxPer>${SALARY_PERIOD_TOKEN_SRC})?`,
  );
}

/**
 * Build the suffix-anchored salary regex: the FIRST number must be
 * FOLLOWED by a currency symbol or ISO code. Same named groups as the
 * prefix variant. Form:
 *
 *   legacy:   <num>K?\s*<sym>\s*<dash>\s*<num>K?[\s<sym>?]
 *   extended: <num>K?\s*<sym>\s*[<per>\s*]<dash|to>\s*<num>K?\s*[<sym>\s*][+\s*][<per>]
 *
 * Matches Continental EUR `45.000 € – 60.000 €`, Nordic kr
 * `500.000 kr - 700.000 kr`, Polish PLN `50 000 zł – 80 000 zł`,
 * `45.000 €/Jahr - 60.000 €/Jahr`. The trailing symbol on the second
 * number is optional after a dash so terse postings like
 * `'45.000 € – 60.000'` still parse; the word separator `to` requires it.
 */
function buildSalaryRegexSuffix(
  symbolAlt: string,
  numSrc: string,
  grammar: SalaryGrammar = 'extended',
): RegExp {
  // Same `[kK]?\b` discipline as the prefix variant — see the
  // commentary on {@link buildSalaryRegexPrefix} for the
  // `kr`-disambiguation rationale.
  if (grammar === 'legacy') {
    return new RegExp(
      `(?<min>${numSrc})\\s*(?<minK>[kK]?\\b)\\s*(?:${symbolAlt})` +
        `\\s*[-–—]\\s*` +
        `(?<max>${numSrc})\\s*(?<maxK>[kK]?\\b)\\s*(?:${symbolAlt})?`,
    );
  }
  const scale = SALARY_RANGE_SCALE_LOOKAHEAD;
  return new RegExp(
    `(?<min>${numSrc})\\s*(?<minK>[kK]?\\b)${scale}\\s*(?:${symbolAlt})\\s*` +
      `(?:(?<minPer>${SALARY_PERIOD_TOKEN_SRC})\\s*)?` +
      `(?:[-–—]|(?<to>${SALARY_WORD_SEPARATOR_SRC})(?=\\s*${numSrc}\\s*[kK]?\\b\\s*(?:${symbolAlt})))\\s*` +
      `(?<max>${numSrc})\\s*(?<maxK>[kK]?\\b)${scale}` +
      `\\s*(?:(?:${symbolAlt})\\s*)?(?:\\+\\s*)?` +
      `(?<maxPer>${SALARY_PERIOD_TOKEN_SRC})?`,
  );
}

/**
 * Build the bare-numeric-range salary regex: NEITHER number requires
 * a currency symbol or ISO code. Captures the same named groups as
 * the prefix / suffix variants (`min`, `minK`, `max`, `maxK`, and in
 * the extended grammar `minPer` / `maxPer`) so the existing K-suffix
 * arithmetic at {@link extractSalary} doesn't need a branch to
 * handle the bare match. Form:
 *
 *   legacy:   <num>K?\s*<dash>\s*<num>K?
 *   extended: <num>K?\s*[<per>\s*]<dash>\s*<num>K?[\s*<per>]
 *
 * Deliberately dash-only in both grammars: with no currency anchor, a
 * word separator would turn prose (`"5 to 7 years"`) into candidates.
 *
 * Spec 014 / T03 (Q-026) — this third variant lands ONLY when
 * `parseSalaryCurrency()` resolved the currency via the country
 * tier (`detected.confidence === 'country'`), so it never fires for
 * no-currency-signal inputs. The country-tier guard is the
 * load-bearing safety: a bare regex without it would over-match
 * plain-prose number ranges like `"5 - 7 years experience"` for
 * any caller that didn't pass a country hint. The two-line guard
 * lives at {@link extractSalary} (after the prefix/suffix cascade);
 * this builder is currency-agnostic.
 *
 * Matches Continental EU bare-number ranges like `"100.000 -
 * 150.000"` (`country=GERMANY` → EUR via the country tier; the
 * regex captures `100.000` / `150.000` against the continental
 * `numSrc`). Also matches anglo bare-number ranges like
 * `"100,000 - 150,000"` when the caller supplies a non-USA anglo
 * country (`country=UK` → GBP; `country=AUSTRALIA` would too if
 * `Country.AUSTRALIA` ever lands in `SALARY_COUNTRY_TO_CURRENCY`).
 */
function buildSalaryRegexBare(
  numSrc: string,
  grammar: SalaryGrammar = 'extended',
): RegExp {
  // Same `[kK]?\b` discipline as the other two variants — pins the
  // K-suffix to a word boundary so `100K -` parses cleanly.
  if (grammar === 'legacy') {
    return new RegExp(
      `(?<min>${numSrc})\\s*(?<minK>[kK]?\\b)\\s*[-–—]\\s*(?<max>${numSrc})\\s*(?<maxK>[kK]?\\b)`,
    );
  }
  return new RegExp(
    `(?<min>${numSrc})\\s*(?<minK>[kK]?\\b)\\s*` +
      `(?:(?<minPer>${SALARY_PERIOD_TOKEN_SRC})\\s*)?` +
      `[-–—]\\s*` +
      `(?<max>${numSrc})\\s*(?<maxK>[kK]?\\b)` +
      `(?:\\s*(?<maxPer>${SALARY_PERIOD_TOKEN_SRC}))?`,
  );
}

/**
 * Spec 5045 — annualization factor per pay period (hourly = 40h × 52w;
 * daily = 5d × 52w; weekly = 52w; monthly = 12m). Used for the bounds check
 * when the period is stated — by the {@link ExtractSalaryOptions.interval}
 * hint or, Spec 1695, by a pay-period token in the text — and by
 * {@link convertToAnnual}.
 */
const ANNUALIZATION_FACTORS: Record<CompensationInterval, number> = {
  [CompensationInterval.HOURLY]: 2080,
  [CompensationInterval.DAILY]: 260,
  [CompensationInterval.WEEKLY]: 52,
  [CompensationInterval.MONTHLY]: 12,
  [CompensationInterval.YEARLY]: 1,
};

/**
 * Spec 5058 — directional keyword / suffix vocabulary that marks a SINGLE
 * stated salary bound (as opposed to a two-ended `min – max` range). A `lower`
 * marker opens an unbounded-above band ("from $X", "$X+", "at least $X"); an
 * `upper` marker opens an unbounded-below band ("up to $Y", "$Y or less").
 *
 * The vocabulary is English-only by design: the anchored single-bound matcher
 * still REQUIRES a currency symbol / ISO code on the amount itself (via
 * `symbolAlt`), so a bare prose number like `"at least 5 years"` never matches
 * regardless of the keyword. Extending to non-English lead-ins / symbol-less
 * amounts is deferred (see Q-090).
 */
const SALARY_LOWER_LEADINS =
  'from|starting\\s+(?:at|from)|starts\\s+(?:at|from)|starting|at\\s+least|minimum(?:\\s+of)?|min(?:\\s+of)?';
const SALARY_UPPER_LEADINS =
  'up\\s+to|upto|no\\s+more\\s+than|maximum(?:\\s+of)?|max(?:\\s+of)?';
const SALARY_LOWER_TRAILERS =
  '\\+|and\\s+up|and\\s+above|or\\s+more|or\\s+higher|or\\s+above|or\\s+greater';
const SALARY_UPPER_TRAILERS =
  'or\\s+less|or\\s+lower|or\\s+under|or\\s+below|and\\s+under|and\\s+below';

/**
 * Scale words that must NOT follow the captured amount — guards the
 * single-bound matcher against lifting `"$5"` out of `"from $5 million"`
 * (which would synthesise a bogus $5 floor). Spelled-out scales only; the
 * ambiguous single-letter `m`/`b` are left out to avoid colliding with
 * `"month"` etc.
 */
const SALARY_SCALE_LOOKAHEAD = '(?!\\s*(?:million|billion|mln|bln|trillion))';

/**
 * Spec 1695 — the same scale guard for the (case-sensitive) range regexes
 * of the extended grammar, so `"$5 - $10 million"` / `"$5 to $10 Million"`
 * are not read as an hourly 5-10 range.
 */
const SALARY_RANGE_SCALE_LOOKAHEAD = caseInsensitiveSrc(SALARY_SCALE_LOOKAHEAD);

interface SingleBoundSalaryMatch {
  bound: 'min' | 'max';
  raw: string;
  kSuffix: string;
  /** Spec 1695 — raw pay-period token right after the amount (`"/hr"`, `" per year"`). */
  period: string | undefined;
}

/**
 * Spec 5058 — match a single stated salary bound (lower-only or upper-only)
 * when the two-ended range cascade in {@link extractSalary} misses. The amount
 * MUST carry a currency symbol / ISO code (prefix `$100k` or suffix `100k €`);
 * bare numbers are rejected so plain prose ("at least 5 years") cannot match.
 *
 * Ordered so keyword-led shapes ("from $X" / "up to $Y") win over the terser
 * trailer shapes ("$X+" / "$Y or less"). Returns `null` when no single-bound
 * shape is present. Spec 1695 — in the extended grammar the amount may carry
 * a pay-period token (`"$25/hr+"`, `"up to $4,000/mo"`), returned as `period`.
 */
function matchSingleBoundSalary(
  salaryStr: string,
  symbolAlt: string,
  numSrc: string,
  grammar: SalaryGrammar = 'extended',
  upperBoundNeedsSalaryCue = false,
): SingleBoundSalaryMatch | null {
  const candidates = cachedSingleBoundCandidates(symbolAlt, numSrc, grammar);
  const extended = grammar === 'extended';
  for (const { re, bound } of candidates) {
    // Global regexes: reset before each scan (synchronous, so never shared mid-scan).
    re.lastIndex = 0;
    for (let m = re.exec(salaryStr); m !== null; m = re.exec(salaryStr)) {
      if (extended || upperBoundNeedsSalaryCue) {
        // Spec 1695 — "relocation up to $10,000" / "bonus from $2,000" state a
        // benefit, not the pay; an upper-only figure may also need a salary word.
        const context = salaryContextBefore(salaryStr, m.index);
        const benefit = extended && context.nearest === 'benefit';
        const uncued =
          upperBoundNeedsSalaryCue && bound === 'max' && (!context.hasCue || context.hasBenefit);
        if (benefit || uncued) {
          re.lastIndex = m.index + 1;
          continue;
        }
      }
      re.lastIndex = 0;
      return { bound, raw: m[1], kSuffix: m[2], period: m.groups?.per };
    }
  }
  return null;
}

/** One single-bound shape: its regex and the bound it states. */
type SingleBoundCandidate = { readonly re: RegExp; readonly bound: 'min' | 'max' };

/** Spec 1695 — compiled once per currency / locale / grammar, like the range regexes. */
const SINGLE_BOUND_CANDIDATE_CACHE = new Map<string, ReadonlyArray<SingleBoundCandidate>>();

function cachedSingleBoundCandidates(
  symbolAlt: string,
  numSrc: string,
  grammar: SalaryGrammar,
): ReadonlyArray<SingleBoundCandidate> {
  const key = `${grammar}|${symbolAlt}|${numSrc}`;
  let candidates = SINGLE_BOUND_CANDIDATE_CACHE.get(key);
  if (!candidates) {
    candidates = buildSingleBoundCandidates(symbolAlt, numSrc, grammar);
    SINGLE_BOUND_CANDIDATE_CACHE.set(key, candidates);
  }
  return candidates;
}

function buildSingleBoundCandidates(
  symbolAlt: string,
  numSrc: string,
  grammar: SalaryGrammar,
): ReadonlyArray<SingleBoundCandidate> {
  // Force the number to match maximally: without this, JS backtracking would
  // let `numSrc` stop mid-thousands (e.g. capture `100` out of `100,000`) so
  // the range-tail guard below could be sidestepped. The class holds only the
  // intra-number separators (comma / period / apostrophe / U+00A0), never a
  // regular space, so a legitimate `"$48,000 per year"` still ends cleanly.
  const numBoundary = "(?![\\d,.'\\u00A0])";
  const extended = grammar === 'extended';
  const period = extended ? `(?:\\s*(?<per>${SALARY_PERIOD_TOKEN_SRC}))?` : '';
  const amtPrefix =
    `(?:${symbolAlt})\\s*(${numSrc})${numBoundary}\\s*([kK]?\\b)${SALARY_SCALE_LOOKAHEAD}${period}`;
  const amtSuffix =
    `(${numSrc})${numBoundary}\\s*([kK]?\\b)${SALARY_SCALE_LOOKAHEAD}\\s*(?:${symbolAlt})${period}`;

  // Negative lookahead rejecting a two-ended range dressed in a lower-leadin —
  // e.g. "from $100,000 to 150,000" is a range, not a floor, so we must NOT
  // truncate it to a min-only. The extended grammar's range cascade reads a
  // "to"-range only when both amounts carry a currency, so this guard leaves
  // the rest as no-match (their prior behaviour) rather than silently dropping
  // the ceiling. In the extended grammar the guard also looks past an optional
  // pay-period token, so `"from $40/hr to 60"` cannot backtrack out of the
  // token and slip through as a `$40` floor.
  const rangeTail = extended
    ? `(?!(?:\\s*(?:${SALARY_PERIOD_TOKEN_SRC}))?\\s*(?:to|through|[-–—])\\s*(?:${symbolAlt})?\\s*${numSrc})`
    : `(?!\\s*(?:to|through|[-–—])\\s*(?:${symbolAlt})?\\s*${numSrc})`;

  return [
    { re: new RegExp(`\\b(?:${SALARY_LOWER_LEADINS})\\b[\\s:]*${amtPrefix}${rangeTail}`, 'gi'), bound: 'min' },
    { re: new RegExp(`\\b(?:${SALARY_LOWER_LEADINS})\\b[\\s:]*${amtSuffix}${rangeTail}`, 'gi'), bound: 'min' },
    { re: new RegExp(`\\b(?:${SALARY_UPPER_LEADINS})\\b[\\s:]*${amtPrefix}`, 'gi'), bound: 'max' },
    { re: new RegExp(`\\b(?:${SALARY_UPPER_LEADINS})\\b[\\s:]*${amtSuffix}`, 'gi'), bound: 'max' },
    { re: new RegExp(`${amtPrefix}${rangeTail}\\s*(?:${SALARY_LOWER_TRAILERS})`, 'gi'), bound: 'min' },
    { re: new RegExp(`${amtSuffix}${rangeTail}\\s*(?:${SALARY_LOWER_TRAILERS})`, 'gi'), bound: 'min' },
    { re: new RegExp(`${amtPrefix}${rangeTail}\\s*(?:${SALARY_UPPER_TRAILERS})`, 'gi'), bound: 'max' },
    { re: new RegExp(`${amtSuffix}${rangeTail}\\s*(?:${SALARY_UPPER_TRAILERS})`, 'gi'), bound: 'max' },
  ];
}

/**
 * Extract salary information from a free-form description string.
 *
 * Spec 012 / T03 — multi-currency, locale-aware dispatcher. Resolves
 * currency via {@link parseSalaryCurrency}, picks a locale via
 * {@link resolveSalaryLocale}, builds a per-currency regex, and
 * delegates numeric parsing to {@link parseSalaryNumber}.
 *
 * Behaviour preserved from the pre-Spec-012 implementation
 * (FR-10): every USD-only fixture in the existing test suite stays
 * green byte-for-byte. The new code paths only fire when the input
 * carries a non-USD signal (symbol / ISO code / country hint).
 *
 * Returns the same `{ interval, minAmount, maxAmount, currency }`
 * envelope; `currency` is now an ISO 4217 string rather than a
 * hard-coded `'USD'`. Returns the all-`null` envelope on any
 * failure (no throws — preserves prior contract). Spec 5045 — when
 * {@link ExtractSalaryOptions.interval} is set, the interval is taken from
 * that hint rather than inferred from the amount's magnitude.
 *
 * Spec 1695 — interval precedence, for ranges and single bounds alike:
 * the caller's `interval` hint, then a pay-period token in the text
 * (extended grammar, see {@link SalaryGrammar}), then magnitude. Two
 * different tokens on one range (`"$20/hr - $40,000/yr"`) return the
 * all-`null` envelope. `enforceAnnualSalary` still annualises the amounts
 * and keeps the stated interval.
 */
export function extractSalary(
  salaryStr: string | null,
  options?: ExtractSalaryOptions,
): ExtractSalaryResult {
  const result: ExtractSalaryResult = {
    interval: null,
    minAmount: null,
    maxAmount: null,
    currency: null,
  };

  if (!salaryStr) return result;

  const lowerLimit = options?.lowerLimit ?? 1000;
  const upperLimit = options?.upperLimit ?? 700000;
  const hourlyThreshold = options?.hourlyThreshold ?? 350;
  const monthlyThreshold = options?.monthlyThreshold ?? 30000;
  const enforceAnnualSalary = options?.enforceAnnualSalary ?? false;
  const grammar = resolveSalaryGrammar(options?.grammar);

  const detected = parseSalaryCurrency(salaryStr, {
    country: options?.country,
    defaultCode: options?.defaultCurrency,
  });
  const locale = resolveSalaryLocale(options, detected.code, detected.confidence);
  const symbolAlt = SALARY_SYMBOL_ALTERNATIONS.get(detected.code);
  if (!symbolAlt) return result;

  const numSrc = SALARY_NUMBER_REGEX_SRC[locale];
  // Try the prefix-anchored shape first (covers USD / GBP / CHF /
  // ISO-prefixed inputs); fall through to the suffix-anchored shape
  // (covers Continental EUR / Nordic kr / Polish zł). The two shapes
  // are tried sequentially because a single combined regex would
  // require either (a) overly permissive optional anchors that match
  // bare number ranges, or (b) a complex alternation that doubles
  // the regex compile cost on the hot path.
  const cacheKey = `${grammar}|${symbolAlt}|${numSrc}`;
  const prefixPattern = cachedSalaryRegex(`prefix|${cacheKey}`, () =>
    buildSalaryRegexPrefix(symbolAlt, numSrc, grammar),
  );
  const suffixPattern = cachedSalaryRegex(`suffix|${cacheKey}`, () =>
    buildSalaryRegexSuffix(symbolAlt, numSrc, grammar),
  );
  // Spec 014 / T03 (Q-026) — when both anchored variants miss AND
  // the currency was resolved via the country tier (no symbol / ISO
  // in the input but a `country` hint was supplied), try the bare
  // numeric-range variant. The literal `=== 'country'` guard is
  // load-bearing: a `!== 'default'` shape would wrongly include the
  // `'symbol'` and `'iso'` paths that already passed the first two
  // patterns and missed for some other reason. The `lowerLimit`
  // clamp at line ~709 (`minSalary < lowerLimit` rejection) is the
  // second line of defence against bare-regex over-matching plain
  // prose numbers like `"5 - 7 years experience"` (FR-7 false-
  // positive immunity).
  const barePattern =
    detected.confidence === 'country'
      ? cachedSalaryRegex(`bare|${grammar}|${numSrc}`, () =>
          buildSalaryRegexBare(numSrc, grammar),
        )
      : null;
  // Spec 015 / Q-036 / FR-2 — track the matched path so the bare-
  // path raw-value pre-check below can fire only when the bare
  // regex won. Prefix/suffix paths stay byte-identical (FR-6).
  let matchedFromBare = false;
  let match: RegExpMatchArray | null;
  if (grammar === 'legacy') {
    match = salaryStr.match(prefixPattern);
    if (!match) match = salaryStr.match(suffixPattern);
  } else {
    // Spec 1695 — scan every candidate instead of taking the leftmost, so a
    // benefit range written with "to" cannot shadow the salary after it.
    const fromPrefix = selectRangeMatch(
      salaryStr,
      cachedSalaryRegex(`prefix-g|${cacheKey}`, () => new RegExp(prefixPattern.source, 'g')),
    );
    let picked = fromPrefix?.strong ? fromPrefix : null;
    if (!picked) {
      const fromSuffix = selectRangeMatch(
        salaryStr,
        cachedSalaryRegex(`suffix-g|${cacheKey}`, () => new RegExp(suffixPattern.source, 'g')),
      );
      picked = fromSuffix?.strong ? fromSuffix : (fromPrefix ?? fromSuffix);
    }
    match = picked?.match ?? null;
  }
  if (!match && barePattern) {
    match = salaryStr.match(barePattern);
    if (match) matchedFromBare = true;
  }
  // Spec 5058 — no two-ended range matched. Before giving up, try a single
  // stated bound (lower-only "from $X" / "$X+", upper-only "up to $Y" /
  // "$Y or less"). Ranges always match the cascade above first, so this path
  // never alters range behaviour; it only rescues a genuinely one-sided figure
  // the employer published (which would otherwise be dropped).
  if (!match) {
    const single = matchSingleBoundSalary(
      salaryStr,
      symbolAlt,
      numSrc,
      grammar,
      options?.upperBoundNeedsSalaryCue ?? false,
    );
    if (!single) return result;

    let value = parseSalaryNumber(single.raw, locale);
    if (value === null) return result;
    if (single.kSuffix.toLowerCase() === 'k') value *= 1000;

    // Spec 1695 — caller hint, then the amount's own period token.
    const statedPeriod = options?.interval ?? intervalFromPeriodToken(single.period);
    let interval: string;
    let annual: number;
    if (statedPeriod) {
      interval = statedPeriod;
      annual = value * ANNUALIZATION_FACTORS[statedPeriod];
    } else if (value < hourlyThreshold) {
      interval = CompensationInterval.HOURLY;
      annual = value * 2080;
    } else if (value < monthlyThreshold) {
      interval = CompensationInterval.MONTHLY;
      annual = value * 12;
    } else {
      interval = CompensationInterval.YEARLY;
      annual = value;
    }

    if (annual < lowerLimit || annual > upperLimit) return result;

    const amount = enforceAnnualSalary ? annual : value;
    result.interval = interval;
    result.currency = detected.code;
    if (single.bound === 'min') result.minAmount = amount;
    else result.maxAmount = amount;
    return result;
  }

  // Named groups (Spec 1695): the optional period-token groups sit between
  // the two amounts, so positional indices would shift with the grammar.
  const groups = match.groups ?? {};
  const minK = groups.minK ?? '';
  const maxK = groups.maxK ?? '';
  let minSalary = parseSalaryNumber(groups.min ?? '', locale);
  let maxSalary = parseSalaryNumber(groups.max ?? '', locale);
  if (minSalary === null || maxSalary === null) return result;

  // Spec 015 / Q-036 / FR-2 + Spec 019 / Q-041 / FR-1 —
  // bare-path raw-value pre-check (threshold bumped to
  // `lowerLimit` at run #79; closes Spec 015 / FR-8). The
  // bare regex is necessarily greedy on plain digit ranges
  // ("5 - 7 years experience" captures 5/7); the country-tier
  // guard alone is not a sufficient prose-immunity safety net
  // because hourly annualisation (`* 2080`) lifts small numbers
  // above `lowerLimit` and the bounds check passes. Reject the
  // row dimensionally: if the bare path won, neither end is
  // K-suffixed, and the raw min is below `lowerLimit`
  // (i.e. would not survive even unitary admission against the
  // configured floor), return the all-`null` envelope. Spec 019
  // bumped the multiplier (was the prior `lowerLimit`-divided-by-12
  // sub-threshold; now equals `lowerLimit ≈ 1000`) to reject
  // shapes like `"team of 100 - 150 employees"` (`100 < 1000` →
  // reject) that previously synthesised hourly EUR rows under a
  // `country` hint.
  // The Continental yearly bare-path shape stays admitted via
  // continental-locale parsing (`"100.000 - 150.000"` →
  // `100000 ≥ 1000`). See `docs/PERFORMANCE_TUNING.md`.
  if (
    matchedFromBare &&
    minK.toLowerCase() !== 'k' &&
    maxK.toLowerCase() !== 'k' &&
    minSalary < lowerLimit
  ) {
    return result;
  }

  if (minK.toLowerCase() === 'k' || maxK.toLowerCase() === 'k') {
    minSalary *= 1000;
    maxSalary *= 1000;
  }

  // Spec 1695 — a period token on either amount states the interval; two
  // different ones make the text self-contradictory, so nothing is emitted.
  const tokenPeriod = periodFromTokens(groups.minPer, groups.maxPer);
  if (tokenPeriod === 'conflict') return result;
  const statedPeriod = options?.interval ?? tokenPeriod;

  let interval: string;
  let annualMinSalary: number;
  let annualMaxSalary: number | null = null;

  if (statedPeriod) {
    // Spec 5045 — trust the caller's explicit pay period (or, Spec 1695, the
    // one written in the text) over the magnitude heuristic; annualize both
    // ends with the period's factor for the bounds check (never `null`, so a
    // genuine range is not dropped by the crossing guard the magnitude
    // branches use).
    interval = statedPeriod;
    const factor = ANNUALIZATION_FACTORS[statedPeriod];
    annualMinSalary = minSalary * factor;
    annualMaxSalary = maxSalary * factor;
  } else if (minSalary < hourlyThreshold) {
    interval = CompensationInterval.HOURLY;
    annualMinSalary = minSalary * 2080;
    annualMaxSalary = maxSalary < hourlyThreshold ? maxSalary * 2080 : null;
  } else if (minSalary < monthlyThreshold) {
    interval = CompensationInterval.MONTHLY;
    annualMinSalary = minSalary * 12;
    annualMaxSalary = maxSalary < monthlyThreshold ? maxSalary * 12 : null;
  } else {
    interval = CompensationInterval.YEARLY;
    annualMinSalary = minSalary;
    annualMaxSalary = maxSalary;
  }

  if (annualMaxSalary === null) return result;

  if (
    annualMinSalary >= lowerLimit &&
    annualMinSalary <= upperLimit &&
    annualMaxSalary >= lowerLimit &&
    annualMaxSalary <= upperLimit &&
    annualMinSalary < annualMaxSalary
  ) {
    return {
      interval,
      minAmount: enforceAnnualSalary ? annualMinSalary : minSalary,
      maxAmount: enforceAnnualSalary ? annualMaxSalary : maxSalary,
      currency: detected.code,
    };
  }

  return result;
}

/**
 * Map an {@link extractSalary} result envelope to a {@link CompensationDto}.
 *
 * Spec 5018 — single source of truth for the `ExtractSalaryResult →
 * CompensationDto` shape that ATS plugins previously hand-rolled (workday,
 * breezyhr, bamboohr, rippling). Returns `null` when the parse yielded no
 * bounded amount, so a "no salary in text" result never produces an empty
 * compensation object. The pay-period string is normalised through
 * {@link getCompensationInterval}; `currency` is passed through verbatim
 * (`CompensationDto` defaults a missing currency to `'USD'`), preserving the
 * pre-refactor behaviour byte-for-byte.
 */
export function compensationFromSalary(
  parsed: ExtractSalaryResult,
): CompensationDto | null {
  if (parsed.minAmount == null && parsed.maxAmount == null) return null;

  const interval = parsed.interval
    ? getCompensationInterval(parsed.interval)
    : null;

  return new CompensationDto({
    interval: interval ?? undefined,
    minAmount: parsed.minAmount ?? undefined,
    maxAmount: parsed.maxAmount ?? undefined,
    currency: parsed.currency ?? undefined,
  });
}

/**
 * Parse a free-text salary string straight into a {@link CompensationDto}.
 *
 * Spec 5018 — convenience wrapper combining {@link extractSalary} and
 * {@link compensationFromSalary}. This is the "description fallback" half of
 * the structured-first compensation pattern: callers run it on free-form body
 * text when their structured source is absent. Returns `null` for empty input
 * or any text without a recognisable salary range (no throws).
 */
export function salaryToCompensation(
  text: string | null | undefined,
  options?: ExtractSalaryOptions,
): CompensationDto | null {
  if (!text || !text.trim()) return null;
  return compensationFromSalary(extractSalary(text, options));
}

/**
 * Resolve compensation with the structured-first, text-fallback precedence.
 *
 * Spec 5018 — the canonical rule (discovered with Rippling): prefer a
 * structured compensation object parsed from the ATS payload; only when that
 * is absent, fall back to parsing the free-text description via
 * {@link salaryToCompensation}. Centralising this here keeps every ATS plugin
 * on the same precedence and mapping, so a future fix lands once.
 */
export function resolveCompensation(args: {
  structured?: CompensationDto | null;
  text?: string | null;
  options?: ExtractSalaryOptions;
}): CompensationDto | null {
  return (
    args.structured ?? salaryToCompensation(args.text ?? null, args.options)
  );
}

/**
 * A single bounded compensation range, e.g. one geo/level/work-mode tier from
 * an ATS payload. At least one of `minAmount` / `maxAmount` should be set for
 * the range to contribute to the aggregate.
 */
export interface CompensationRange {
  minAmount?: number | null;
  maxAmount?: number | null;
  currency?: string | null;
  interval?: CompensationInterval | null;
}

/**
 * Fold many compensation ranges (e.g. per-location or per-level tiers) into a
 * single overall min–max envelope: `minAmount = min(all floors)`,
 * `maxAmount = max(all ceilings)`.
 *
 * Spec 5019 — single source of truth for the multi-tier collapse that Rippling
 * discovered (`payRangeDetails[]` → `Math.min(starts)…Math.max(ends)`). ATS
 * plugins that expose several pay bands (rippling, ashby tiers) call this so a
 * posting with SF/NYC/remote tiers reports the true overall band instead of an
 * arbitrary first tier.
 *
 * Mixed units are never averaged together: the **first bounded range** sets the
 * basis currency + interval, and only ranges sharing that currency and interval
 * contribute to the fold (so a stray EUR or hourly band can't pollute a USD
 * yearly aggregate). Returns `null` when no range carries a bounded amount.
 */
export function aggregateCompensation(
  ranges: ReadonlyArray<CompensationRange | null | undefined>,
): CompensationDto | null {
  const bounded = ranges.filter(
    (range): range is CompensationRange =>
      range != null &&
      (range.minAmount != null || range.maxAmount != null),
  );
  if (bounded.length === 0) return null;

  const basis = bounded[0];
  const sameUnit = bounded.filter(
    (range) =>
      (range.currency ?? null) === (basis.currency ?? null) &&
      (range.interval ?? null) === (basis.interval ?? null),
  );

  const mins = sameUnit
    .map((range) => range.minAmount)
    .filter((value): value is number => value != null);
  const maxes = sameUnit
    .map((range) => range.maxAmount)
    .filter((value): value is number => value != null);

  return new CompensationDto({
    interval: basis.interval ?? undefined,
    minAmount: mins.length > 0 ? Math.min(...mins) : undefined,
    maxAmount: maxes.length > 0 ? Math.max(...maxes) : undefined,
    currency: basis.currency ?? undefined,
  });
}

/**
 * Extract job types from a description using keyword matching.
 * Replaces Python's extract_job_type().
 */
export function extractJobType(description: string | null): JobType[] | null {
  if (!description) return null;

  const keywords: Record<string, RegExp> = {
    [JobType.FULL_TIME]: /full\s?time/i,
    [JobType.PART_TIME]: /part\s?time/i,
    [JobType.INTERNSHIP]: /internship/i,
    [JobType.CONTRACT]: /contract/i,
  };

  const types: JobType[] = [];
  for (const [jobType, pattern] of Object.entries(keywords)) {
    if (pattern.test(description)) {
      types.push(jobType as JobType);
    }
  }

  return types.length > 0 ? types : null;
}

/**
 * Resolve a raw job type string to a JobType enum value.
 * Replaces Python's get_enum_from_job_type().
 *
 * Spec 1697: `options` passes through to `getJobTypeFromString` (a `locale`
 * enables locale-scoped aliases such as French `stage`; `mode: 'token'`
 * ignores the prose-ambiguous aliases). Omitted, the lookup is unchanged.
 */
export function getEnumFromJobType(
  jobTypeStr: string,
  options?: JobTypeLookupOptions,
): JobType | null {
  return getJobTypeFromString(jobTypeStr, options);
}

/** Spec 1695 — options for {@link parseCurrency}. */
export interface ParseCurrencyOptions {
  /**
   * Multiply by 1000 when a `k` / `K` follows the digits (`"$100K"` →
   * 100000, `"1.5k"` → 1500). Default `true`; `false` keeps the earlier
   * reading, which drops the suffix (`"$100K"` → 100).
   */
  thousandsSuffix?: boolean;
}

/**
 * Parse a single money amount out of a display string (`"$1,234.56"`,
 * `"1.234,56"`, `"€45.000"`, `"$100K"`). Every character other than digits,
 * `-`, `.` and `,` is dropped; the last three remaining characters decide
 * the decimal separator (a `,` there without a `.` is a decimal comma) and
 * any separator before them is a thousands separator. The result is rounded
 * to cents.
 *
 * Spec 1695 — returns `null`, never `NaN`, when the text has no digit
 * (`"Negotiable"`, `""`, `"-"`) or does not parse to a finite number, and
 * honours a trailing K (see {@link ParseCurrencyOptions.thousandsSuffix}).
 */
export function parseCurrency(
  curStr: string | null | undefined,
  options?: ParseCurrencyOptions,
): number | null {
  if (curStr == null) return null;
  const text = String(curStr);
  if (!/\d/.test(text)) return null;
  const multiplier =
    (options?.thousandsSuffix ?? true) && /\d\s*[kK](?![A-Za-z])/.test(text) ? 1000 : 1;

  let cleaned = text.replace(/[^-0-9.,]/g, '');
  // Remove thousands separators
  const last3 = cleaned.slice(-3);
  const before = cleaned.slice(0, -3);
  cleaned = before.replace(/[.,]/g, '') + last3;

  const value =
    last3.includes(',') && !last3.includes('.')
      ? parseFloat(cleaned.replace(',', '.'))
      : parseFloat(cleaned);
  if (!Number.isFinite(value)) return null;
  return Math.round(value * multiplier * 100) / 100;
}

/** A bound counts as present only when it is a finite number. */
function isFiniteAmount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Annualise a compensation-like object in place (a {@link CompensationDto}
 * or any `{ interval, minAmount, maxAmount }` shape). The interval is
 * normalised through {@link getCompensationInterval} (`hourly`, `HOURLY`,
 * `hour` …), each bound that is a finite number is multiplied by the
 * period's factor (hourly 2080, daily 260, weekly 52, monthly 12) and
 * rounded to cents, and the interval becomes `yearly`.
 *
 * Spec 1695 — a missing bound stays missing (it used to become `0`), and
 * nothing changes when the interval is missing, unknown (`biweekly`) or
 * already yearly, or when no bound is present. Returns whether the object
 * was changed.
 */
export function convertToAnnual(jobData: {
  interval?: string | null;
  minAmount?: number | null;
  maxAmount?: number | null;
}): boolean {
  const interval = jobData.interval ? getCompensationInterval(jobData.interval) : null;
  if (!interval || interval === CompensationInterval.YEARLY) return false;
  const hasMin = isFiniteAmount(jobData.minAmount);
  const hasMax = isFiniteAmount(jobData.maxAmount);
  if (!hasMin && !hasMax) return false;

  const factor = ANNUALIZATION_FACTORS[interval];
  if (hasMin) jobData.minAmount = Math.round((jobData.minAmount as number) * factor * 100) / 100;
  if (hasMax) jobData.maxAmount = Math.round((jobData.maxAmount as number) * factor * 100) / 100;
  jobData.interval = CompensationInterval.YEARLY;
  return true;
}

/**
 * Spec 1695 — whether a compensation carries a usable amount: at least one
 * bound that is a finite number above zero. A `0` / `0` pair is a common
 * "not disclosed" placeholder, so it does not count.
 */
export function hasSalaryAmount(
  compensation:
    | { minAmount?: number | null; maxAmount?: number | null }
    | null
    | undefined,
): boolean {
  if (!compensation) return false;
  const usable = (value: unknown): boolean => isFiniteAmount(value) && value > 0;
  return usable(compensation.minAmount) || usable(compensation.maxAmount);
}

/** Spec 1695 — input of {@link postProcessCompensation}. */
export interface PostProcessCompensationInput {
  /** Compensation the source returned, if any. */
  compensation?: CompensationDto | null;
  /** Job description, read only when no direct amount exists. */
  description?: string | null;
  /** Search country; the description fallback runs for the USA only. Default USA. */
  country?: Country;
  /** Annualise the final compensation (`ScraperInputDto.enforceAnnualSalary`). */
  enforceAnnualSalary?: boolean;
  /** Grammar for the description parse; `legacy` also restores the legacy rules. */
  grammar?: SalaryGrammar;
}

/** Spec 1695 — result of {@link postProcessCompensation}. */
export interface PostProcessCompensationResult {
  compensation: CompensationDto | null | undefined;
  salarySource: SalarySource | undefined;
}

/**
 * Spec 1695 — the post-scrape salary rule for one job, as a pure function
 * (the input compensation is never mutated; an annualised one is a copy).
 *
 * Extended rules (default):
 * 1. A compensation with a usable amount ({@link hasSalaryAmount}) is kept
 *    and marked `direct_data` — a single bound counts.
 * 2. Otherwise, for the USA, the description is parsed with
 *    {@link salaryToCompensation} in its own period and marked `description`.
 *    An upper-only figure counts only with a salary word before it in its
 *    clause and no benefit word there
 *    ({@link ExtractSalaryOptions.upperBoundNeedsSalaryCue}): `"Compensation:
 *    up to $90,000"` is read, `"relocation assistance up to $10,000"` and
 *    `"401(k) match up to $5,000"` are not. A compensation without an amount (only
 *    a currency, or `0` / `0`) does not block this fallback.
 * 3. With `enforceAnnualSalary`, the chosen compensation is annualised by
 *    {@link convertToAnnual}, so the interval says `yearly` whenever the
 *    amounts are yearly, and a single bound is annualised too.
 * 4. `salarySource` is cleared when no usable amount remains.
 *
 * `grammar: 'legacy'` (or `EVER_JOBS_SALARY_GRAMMAR=legacy`) applies the
 * rules as they were before Spec 1695: any compensation object blocks the
 * description fallback; direct amounts are annualised only when both bounds
 * are set; the description is parsed pre-annualised (keeping its source
 * interval) and accepted only with a lower bound; the source is cleared
 * unless `minAmount` is truthy.
 */
export function postProcessCompensation(
  input: PostProcessCompensationInput,
): PostProcessCompensationResult {
  const enforceAnnual = input.enforceAnnualSalary ?? false;
  const country = input.country ?? Country.USA;
  const grammar = resolveSalaryGrammar(input.grammar);
  if (grammar === 'legacy') {
    return legacyPostProcessCompensation(input.compensation, input.description, country, enforceAnnual);
  }

  let compensation = input.compensation;
  let salarySource: SalarySource | undefined;
  if (hasSalaryAmount(compensation)) {
    salarySource = SalarySource.DIRECT_DATA;
  } else if (country === Country.USA && input.description) {
    const fromText = salaryToCompensation(input.description, {
      grammar,
      upperBoundNeedsSalaryCue: true,
    });
    if (fromText) {
      compensation = fromText;
      salarySource = SalarySource.DESCRIPTION;
    }
  }

  if (enforceAnnual && compensation) {
    const annualised = copyCompensation(compensation);
    if (convertToAnnual(annualised)) compensation = annualised;
  }

  if (!hasSalaryAmount(compensation)) salarySource = undefined;
  return { compensation, salarySource };
}

/** The pre-Spec-1695 post-scrape salary rule, kept reachable behind the legacy grammar. */
function legacyPostProcessCompensation(
  original: CompensationDto | null | undefined,
  description: string | null | undefined,
  country: Country,
  enforceAnnual: boolean,
): PostProcessCompensationResult {
  let compensation = original;
  let salarySource: SalarySource | undefined;
  if (compensation) {
    salarySource = SalarySource.DIRECT_DATA;
    const factor = compensation.interval
      ? LEGACY_ANNUAL_MULTIPLIERS[compensation.interval]
      : undefined;
    if (
      enforceAnnual &&
      factor &&
      compensation.minAmount != null &&
      compensation.maxAmount != null
    ) {
      const annualised = copyCompensation(compensation);
      annualised.minAmount = compensation.minAmount * factor;
      annualised.maxAmount = compensation.maxAmount * factor;
      annualised.interval = CompensationInterval.YEARLY;
      compensation = annualised;
    }
  } else if (country === Country.USA && description) {
    const extracted = extractSalary(description, {
      enforceAnnualSalary: enforceAnnual,
      grammar: 'legacy',
    });
    if (extracted.minAmount != null) {
      salarySource = SalarySource.DESCRIPTION;
      compensation = new CompensationDto({
        interval: (extracted.interval as CompensationInterval | null) ?? undefined,
        minAmount: extracted.minAmount,
        maxAmount: extracted.maxAmount,
        currency: extracted.currency ?? 'USD',
      });
    }
  }
  if (!compensation?.minAmount) salarySource = undefined;
  return { compensation, salarySource };
}

/** The multiplier table the pre-Spec-1695 annualisation used (lowercase keys only). */
const LEGACY_ANNUAL_MULTIPLIERS: Readonly<Record<string, number>> = {
  hourly: 2080,
  monthly: 12,
  weekly: 52,
  daily: 260,
};

/** Shallow copy that keeps every own field, including an explicit `currency: undefined`. */
function copyCompensation(compensation: CompensationDto): CompensationDto {
  return Object.assign(new CompensationDto(), compensation);
}

/**
 * Desired column order for output (matches Python desired_order list).
 */
export const DESIRED_ORDER: string[] = [
  'id', 'site', 'jobUrl', 'jobUrlDirect', 'title', 'company', 'location',
  'datePosted', 'jobType', 'salarySource', 'interval', 'minAmount', 'maxAmount',
  'currency', 'isRemote', 'jobLevel', 'jobFunction', 'listingType', 'emails',
  'description', 'companyIndustry', 'companyUrl', 'companyLogo', 'companyUrlDirect',
  'companyAddresses', 'companyNumEmployees', 'companyRevenue', 'companyDescription',
  'skills', 'experienceRange', 'companyRating', 'companyReviewsCount',
  'vacancyCount', 'workFromHomeType',
];

/**
 * Sleep utility for adding delays between requests.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Sleep for a random duration between min and max milliseconds.
 */
export function randomSleep(minMs: number, maxMs: number): Promise<void> {
  const duration = Math.random() * (maxMs - minMs) + minMs;
  return sleep(duration);
}
