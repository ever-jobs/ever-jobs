/**
 * Canonicalisation helpers used by the dedup engine (Spec 003 / FR-3).
 *
 * Each function is **pure**, **deterministic**, and **idempotent**:
 *   normalize(normalize(x)) === normalize(x)
 *
 * They strip cosmetic differences ("Acme, Inc." vs "ACME Inc") so the
 * canonical-key hash stays stable across sources.
 */

/* ────────────────────────────────────────────────────────────────────── *
 *  Common pre-processing
 * ────────────────────────────────────────────────────────────────────── */

const NBSP_RE = /[   ]/g;
const COMBINING_MARKS_RE = /\p{M}/gu;
const MULTI_WS_RE = /\s+/g;

/**
 * Lower-cases + strips diacritics + collapses whitespace. Used as the base
 * for all three normalisers. Don't export — callers should use the typed
 * `normalizeCompany`/`normalizeTitle`/`normalizeLocation` wrappers.
 */
function baseNormalize(input: string): string {
  return input
    .normalize('NFKD')
    .replace(COMBINING_MARKS_RE, '')
    .replace(NBSP_RE, ' ')
    .replace(MULTI_WS_RE, ' ')
    .trim()
    .toLowerCase();
}

/* ────────────────────────────────────────────────────────────────────── *
 *  Company
 * ────────────────────────────────────────────────────────────────────── */

/**
 * Suffixes that legally identify a company but never affect identity.
 * Order matters — multi-word suffixes must be removed first.
 */
const COMPANY_SUFFIXES: ReadonlyArray<RegExp> = [
  /\b(?:gesellschaft mit beschr[aä]nkter haftung)\b/g,
  /\b(?:public limited company)\b/g,
  /\b(?:limited liability company)\b/g,
  /\b(?:incorporated|incorporation)\b/g,
  /\b(?:corporation|corp\.?)\b/g,
  /\b(?:company|co\.?)\b/g,
  /\b(?:limited|ltd\.?)\b/g,
  /\b(?:l\.?l\.?c\.?)\b/g,
  /\b(?:p\.?l\.?c\.?)\b/g,
  /\b(?:gmbh|ag|kg|s\.?a\.?|s\.?l\.?|s\.?r\.?l\.?|sas|oy|ab|bv|nv)\b/g,
  /\b(?:pty\.?|pte\.?|inc\.?)\b/g,
  /\b(?:holdings?|group|technologies|technology|systems?|solutions?|services?|labs?|studios?)\b/g,
];

const PUNCT_RE = /[.,;:!?'`"‘’“”()\[\]{}<>]/g;

/**
 * Canonicalise a company name.
 *
 * Examples:
 *   "Acme, Inc."        → "acme"
 *   "ACME Corporation"  → "acme"
 *   "Some Co., Ltd."    → "some"
 *   "Müller GmbH"       → "muller"
 *   "OpenAI, L.L.C."    → "openai"
 */
export function normalizeCompany(input: string | null | undefined): string {
  if (!input) return '';
  let s = baseNormalize(input);
  // Strip suffixes BEFORE punctuation: patterns like `l\.?l\.?c\.?` rely on
  // the dots still being there.
  for (const re of COMPANY_SUFFIXES) {
    s = s.replace(re, ' ');
  }
  // Remove ampersand & "and" word forms — "Smith & Sons" === "Smith and Sons".
  s = s.replace(/\s+(?:&|and)\s+/g, ' ');
  // Now drop leftover punctuation.
  s = s.replace(PUNCT_RE, ' ');
  return s.replace(MULTI_WS_RE, ' ').trim();
}

/* ────────────────────────────────────────────────────────────────────── *
 *  Title
 * ────────────────────────────────────────────────────────────────────── */

const TITLE_SENIORITY_ALIASES: ReadonlyArray<[RegExp, string]> = [
  [/\bsr\.?\b/g, 'senior'],
  [/\bjr\.?\b/g, 'junior'],
  [/\bii\b/g, '2'],
  [/\biii\b/g, '3'],
  [/\biv\b/g, '4'],
  [/\bsoftware engineer\b/g, 'swe'],
  [/\bmachine learning\b/g, 'ml'],
  [/\bdata scientist\b/g, 'ds'],
  [/\bsite reliability engineer\b/g, 'sre'],
  [/\bproduct manager\b/g, 'pm'],
];

const TITLE_NOISE: ReadonlyArray<(s: string) => string> = [
  // Parenthesised/bracketed extras: "(Remote)", "[NYC]", etc. — the same
  // spans `/\([^)]*\)/g` and `/\[[^\]]*\]/g` match, found in linear time
  (s) => stripDelimited(s, '(', ')'),
  (s) => stripDelimited(s, '[', ']'),
  // Trailing slashes/pipes: "Backend / Go", "Engineer | Remote"
  (s) => s.replace(/[/|]/g, ' '),
];

/**
 * Replace every `open … close` span with a space — exactly the matches of
 * `/\(([^)]*)\)/g` (for '(' / ')'): from an `open` to the FIRST `close` after
 * it. Linear: once an `open` has no `close` after it, no later one can, so
 * the scan stops; the regex instead rescanned the rest of the string from
 * every unmatched `open` (a 20k-char '((((…' title took ~0.5 s).
 */
function stripDelimited(s: string, open: string, close: string): string {
  let out = '';
  let from = 0;
  for (;;) {
    const start = s.indexOf(open, from);
    if (start < 0) break;
    const end = s.indexOf(close, start + 1);
    if (end < 0) break;
    out += `${s.slice(from, start)} `;
    from = end + 1;
  }
  return from === 0 ? s : out + s.slice(from);
}

const WHITESPACE_CHAR_RE = /\s/;

/**
 * Replace every `(…)` span — from a '(' to the FIRST ')' after it, exactly the
 * spans `/\([^)]*\)/g` matches — with `replacement`, in one linear pass
 * (Spec 1689). For plugins that strip parenthetical qualifiers out of scraped
 * labels ('Leeds (Head Office), UK'): the `/\s*\([^)]*\)\s*\/g`-style regexes
 * they used rescan a whitespace run from every position and the rest of the
 * string from every unclosed '(' — quadratic, ~0.6 s on a 20k-char label.
 *
 * `space` reproduces the regex a call site used, exactly:
 *  - 'keep'   (default) `/\([^)]*\)/g` — whitespace around a span stays;
 *  - 'before' `/\s*\([^)]*\)/g` — the whitespace run before a span goes too;
 *  - 'around' `/\s*\([^)]*\)\s*\/g` — the runs on both sides go too.
 */
export function stripParentheticals(
  value: string,
  replacement = ' ',
  { space = 'keep' }: { space?: 'keep' | 'before' | 'around' } = {},
): string {
  let out = '';
  let from = 0;
  for (;;) {
    const open = value.indexOf('(', from);
    if (open < 0) break;
    const close = value.indexOf(')', open + 1);
    if (close < 0) break;
    const head = value.slice(from, open);
    // trimEnd() and `\s` strip the same (ECMAScript WhiteSpace + LineTerminator)
    out += (space === 'keep' ? head : head.trimEnd()) + replacement;
    from = close + 1;
    if (space === 'around') {
      while (from < value.length && WHITESPACE_CHAR_RE.test(value[from])) from++;
    }
  }
  return from === 0 ? value : out + value.slice(from);
}

/**
 * Canonicalise a job title.
 *
 * Examples:
 *   "Sr. Software Engineer"             → "senior swe"
 *   "Senior Software Engineer (Remote)" → "senior swe"
 *   "ML Engineer III"                   → "ml engineer 3"
 */
export function normalizeTitle(input: string | null | undefined): string {
  if (!input) return '';
  let s = baseNormalize(input);
  for (const strip of TITLE_NOISE) s = strip(s);
  s = s.replace(PUNCT_RE, ' ');
  for (const [re, repl] of TITLE_SENIORITY_ALIASES) s = s.replace(re, repl);
  return s.replace(MULTI_WS_RE, ' ').trim();
}

/* ────────────────────────────────────────────────────────────────────── *
 *  Location
 * ────────────────────────────────────────────────────────────────────── */

const LOCATION_REMOTE_TOKENS = /\b(?:remote|work\s*from\s*home|wfh|anywhere|telecommute|virtual)\b/;
const LOCATION_DELIM_RE = /[,;]+/g;

/** Two-letter US-state abbreviations (kept lowercase for matching). */
const US_STATE_ABBR_TO_FULL: Readonly<Record<string, string>> = {
  al: 'alabama', ak: 'alaska', az: 'arizona', ar: 'arkansas', ca: 'california',
  co: 'colorado', ct: 'connecticut', de: 'delaware', fl: 'florida', ga: 'georgia',
  hi: 'hawaii', id: 'idaho', il: 'illinois', in: 'indiana', ia: 'iowa',
  ks: 'kansas', ky: 'kentucky', la: 'louisiana', me: 'maine', md: 'maryland',
  ma: 'massachusetts', mi: 'michigan', mn: 'minnesota', ms: 'mississippi',
  mo: 'missouri', mt: 'montana', ne: 'nebraska', nv: 'nevada', nh: 'new hampshire',
  nj: 'new jersey', nm: 'new mexico', ny: 'new york', nc: 'north carolina',
  nd: 'north dakota', oh: 'ohio', ok: 'oklahoma', or: 'oregon', pa: 'pennsylvania',
  ri: 'rhode island', sc: 'south carolina', sd: 'south dakota', tn: 'tennessee',
  tx: 'texas', ut: 'utah', vt: 'vermont', va: 'virginia', wa: 'washington',
  wv: 'west virginia', wi: 'wisconsin', wy: 'wyoming',
};

/**
 * Canonicalise a location string.
 *
 * Examples:
 *   "Remote, US"           → "remote"
 *   "San Francisco, CA"    → "san francisco california"
 *   "New York, NY, USA"    → "new york new york usa"
 *   "Anywhere"             → "remote"
 */
export function normalizeLocation(input: string | null | undefined): string {
  if (!input) return '';
  let s = baseNormalize(input);
  // If "remote" appears, surface it as a clean token; collapse rest.
  if (LOCATION_REMOTE_TOKENS.test(s) && !s.includes(' in ')) {
    return 'remote';
  }
  s = s.replace(LOCATION_DELIM_RE, ' ');
  s = s.replace(PUNCT_RE, ' ');
  // Expand US state abbreviations (`SF, CA` → `sf california`).
  s = s
    .split(' ')
    .map((tok) => US_STATE_ABBR_TO_FULL[tok] ?? tok)
    .join(' ');
  return s.replace(MULTI_WS_RE, ' ').trim();
}
