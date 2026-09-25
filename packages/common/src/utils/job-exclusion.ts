import {
  ExclusionPreset,
  MAX_EXCLUSION_TERMS,
  MAX_EXCLUSION_TERM_LENGTH,
} from '@ever-jobs/models';
import { decodeHtmlEntities } from './html-utils';

/**
 * Post-scrape exclusion filters (Spec 1700).
 *
 * Callers can drop jobs whose title (`titleTerms`) or title + description
 * (`keywords`, `presets`) mentions a word or phrase. The design rules, each of
 * which exists because the naive version is wrong:
 *
 *  - **An empty spec is a no-op.** Absent, `[]` or all-blank lists keep every
 *    job, in order — never "match nothing, keep nothing".
 *  - **Whole tokens, not substrings.** `sci` must not drop "Research
 *    Scientist"; `lead` must not drop "Leadership Recruiter". Multi-word terms
 *    match as contiguous token phrases; a trailing `*` opts into a prefix
 *    match on the last token (`lead*`, at least 3 characters).
 *  - **No caller-controlled regex, ever.** Terms go through the same fixed,
 *    linear tokenizer as the text and are compared token by token, so `c++`,
 *    `(senior)` or `(a+)+$` are just literal text.
 *  - **Negated mentions do not count.** "No clearance required" and
 *    "Clearance: not required" keep the job. Negation windows and phrases never
 *    cross a clause boundary (`. ! ? ;`, newline, `•`, block-level HTML).
 *  - **HTML is text, not markup.** Entities are decoded and tags stripped with
 *    a linear scanner, so `<p class="senior">` does not match `senior`.
 *  - **Abbreviations are symmetric.** `sr`/`snr` ↔ `senior`, `jr` ↔ `junior`.
 *  - **Scripts without word separators** (Han, Kana, Thai, Lao, Khmer,
 *    Myanmar) fall back to a literal `includes` on the normalised text.
 *
 * Pure, synchronous, never throws on job data. Worst-case work is bounded by
 * {@link MAX_EXCLUSION_TERMS} terms of {@link MAX_EXCLUSION_TERM_TOKENS}
 * tokens over {@link MAX_DESCRIPTION_CHARS_SCANNED} characters of text.
 */

/** Most tokens a single term may compile to. */
export const MAX_EXCLUSION_TERM_TOKENS = 8;

/** Shortest accepted wildcard prefix; `a*` / `se*` are ignored, not honoured. */
export const MIN_EXCLUSION_PREFIX_LENGTH = 3;

/** Characters of a title or description the matcher reads at most. */
export const MAX_DESCRIPTION_CHARS_SCANNED = 100_000;

/** Tokens before (and after) a match inspected for a negation. */
export const EXCLUSION_NEGATION_WINDOW = 3;

/** Most excluded rows a caller may be shown as samples. */
export const MAX_EXCLUSION_SAMPLES = 20;

/** The DTO fields that carry exclusion input. */
export const EXCLUSION_INPUT_KEYS = ['excludeTitleTerms', 'excludeKeywords', 'excludePresets'] as const;

/**
 * Curated preset phrases, matched against title + description.
 *
 * There is deliberately no bare `sci`, `poly` or `secret`: those drop
 * "Scientist", "Polymeric" and "Secretary". "Clearance eligible" / "obtain a
 * clearance" roles are included on purpose — a caller who opts into this
 * preset typically cannot hold a clearance.
 */
export const EXCLUSION_PRESET_TERMS: Readonly<Record<ExclusionPreset, readonly string[]>> = Object.freeze({
  [ExclusionPreset.SECURITY_CLEARANCE]: Object.freeze([
    'security clearance',
    'active clearance',
    'clearance required',
    'clearance eligible',
    'clearance eligibility',
    'obtain a clearance',
    'maintain a clearance',
    'secret clearance',
    'top secret',
    'ts clearance',
    'ts sci',
    'tssci',
    'sci eligible',
    'sci eligibility',
    'sci access',
    'polygraph',
    'ci poly',
    'fs poly',
    'full scope poly',
    'public trust',
    'dod clearance',
    'doe clearance',
    'q clearance',
    'l clearance',
    'nato secret',
    'sc clearance',
    'sc cleared',
    'dv clearance',
    'dv cleared',
    'developed vetting',
    'nv1',
    'nv2',
    'negative vetting',
    'baseline clearance',
    'agsva',
    'reliability status',
  ]),
});

/** What a caller asked to exclude. Every list is optional; `null` means absent. */
export interface JobExclusionSpec {
  /** Matched against the title only. */
  titleTerms?: readonly string[] | null;
  /** Matched against the title and the description. */
  keywords?: readonly string[] | null;
  /** Curated lists, matched against the title and the description. */
  presets?: readonly (ExclusionPreset | string)[] | null;
}

export type ExclusionField = 'title' | 'description';
export type ExclusionSource = 'title_terms' | 'keywords' | `preset:${ExclusionPreset}`;

/** Why a job was excluded: the first non-negated match. */
export interface ExclusionMatch {
  readonly term: string;
  readonly source: ExclusionSource;
  readonly field: ExclusionField;
}

export type IgnoredExclusionReason =
  | 'empty'
  | 'too_long'
  | 'too_many_tokens'
  | 'prefix_too_short'
  | 'over_limit'
  | 'unknown_preset';

/** A term that passed validation but compiles to nothing. Reported, never thrown. */
export interface IgnoredExclusionTerm {
  readonly term: string;
  readonly reason: IgnoredExclusionReason;
}

export interface ExclusionTermCount {
  readonly term: string;
  readonly source: ExclusionSource;
  readonly count: number;
}

export interface JobExclusionMetrics {
  /** Results removed from the final list. */
  readonly excludedCount: number;
  /** Raw observations that matched (pre-dedup when a dedup pass ran). */
  readonly excludedRawCount: number;
  /** Matching rows per term, most frequent first. Sums to `excludedRawCount`. */
  readonly byTerm: ExclusionTermCount[];
  readonly ignoredTerms: IgnoredExclusionTerm[];
}

// ── Normalisation and tokenisation ─────────────────────────────────────

/** A word (letters/digits, keeping a trailing `+`/`#` for c++/c#) or a clause boundary. */
const TOKEN_OR_BOUNDARY = /[\p{L}\p{N}]+[+#]*|[.!?;\n•]/gu;
const WORD_CHAR = /[\p{L}\p{N}]/u;
const COMBINING_MARKS = /\p{M}+/gu;
const SEPARATORLESS_SCRIPT =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
const BOUNDARIES = new Set(['.', '!', '?', ';', '\n', '•']);

/** A `.` after one of these does not end a clause ("Sr. Engineer"). */
const NO_BREAK_ABBREVIATIONS = new Set(['sr', 'snr', 'jr', 'dr', 'mr', 'mrs', 'ms', 'st', 'vs', 'etc', 'inc', 'ltd', 'corp']);

/** Same seniority aliases as `normalizeTitle`, applied to text and terms alike. */
const TOKEN_ALIASES: ReadonlyMap<string, string> = new Map([
  ['sr', 'senior'],
  ['snr', 'senior'],
  ['jr', 'junior'],
]);

const NEGATORS = new Set(['no', 'not', 'non', 'without', 'nor', 'never']);
/** "doesn't" tokenises as `doesn` + `t`. */
const CONTRACTION_STEMS = new Set(['don', 'doesn', 'didn', 'isn', 'aren', 'wasn', 'weren', 'won', 'can', 'couldn', 'shouldn']);
const REQUIREMENT_WORDS = new Set(['required', 'needed', 'necessary', 'mandatory']);
const TRAILING_NEGATIONS = new Set(['none', 'unnecessary']);

const BLOCK_TAGS = new Set([
  'p', 'div', 'li', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'tr', 'td', 'th',
  'ul', 'ol', 'dl', 'dt', 'dd', 'table', 'section', 'article', 'header', 'footer', 'blockquote',
]);

interface TokenizedText {
  readonly tokens: string[];
  /** Clause id per token; phrases and negation windows stay inside one clause. */
  readonly clause: number[];
}

function isAsciiLetter(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

/** Name of the tag opening at `lt` (after an optional `/`), lower-cased. */
function tagNameAt(s: string, lt: number): string {
  let i = lt + 1;
  if (s.charCodeAt(i) === 47 /* / */) i++;
  let name = '';
  while (i < s.length && name.length < 12) {
    const code = s.charCodeAt(i);
    if (isAsciiLetter(code) || (code >= 48 && code <= 57)) {
      name += s[i].toLowerCase();
      i++;
    } else {
      break;
    }
  }
  return name;
}

/**
 * Remove HTML tags in one linear pass. A `<` followed by a letter, `/` or `!`
 * starts a tag that ends at the next `>`; block-level tags become a newline (a
 * clause boundary), others a space. Once a tag has no closing `>`, no later one
 * can either, so stripping stops — unlike `/<[^>]*>/g`, which rescans the rest
 * of the input from every unmatched `<`.
 */
function stripTagsLinear(s: string): string {
  let out = '';
  let from = 0;
  let lt = s.indexOf('<');
  while (lt >= 0) {
    const next = s.charCodeAt(lt + 1);
    if (isAsciiLetter(next) || next === 47 /* / */ || next === 33 /* ! */) {
      const gt = s.indexOf('>', lt + 1);
      if (gt < 0) break;
      out += s.slice(from, lt) + (BLOCK_TAGS.has(tagNameAt(s, lt)) ? '\n' : ' ');
      from = gt + 1;
      lt = s.indexOf('<', from);
    } else {
      lt = s.indexOf('<', lt + 1);
    }
  }
  return from === 0 ? s : out + s.slice(from);
}

/** Lower-case, compatibility-decompose and drop combining marks ("Señor" → "senor"). */
function foldCase(s: string): string {
  return s.toLowerCase().normalize('NFKD').replace(COMBINING_MARKS, '');
}

/** Decode, strip and fold a job field. Never throws on odd input. */
function prepareText(raw: string): string {
  let s = raw.length > MAX_DESCRIPTION_CHARS_SCANNED ? raw.slice(0, MAX_DESCRIPTION_CHARS_SCANNED) : raw;
  if (s.includes('&')) s = decodeHtmlEntities(s);
  if (s.includes('<')) s = stripTagsLinear(s);
  return foldCase(s);
}

/**
 * The one tokenizer shared by text and terms. Word tokens are aliased; clause
 * boundaries advance the clause id instead of producing a token. A `.` only
 * ends a clause when it is followed by a non-word character (so `node.js` and
 * `3.5` do not split) and does not follow a known abbreviation.
 */
function tokenize(folded: string): TokenizedText {
  const tokens: string[] = [];
  const clause: number[] = [];
  let current = 0;
  let previousWord = '';
  for (const m of folded.matchAll(TOKEN_OR_BOUNDARY)) {
    const t = m[0];
    if (t.length === 1 && BOUNDARIES.has(t)) {
      if (t === '.') {
        const next = folded[(m.index ?? 0) + 1];
        if (next !== undefined && WORD_CHAR.test(next)) continue;
        if (NO_BREAK_ABBREVIATIONS.has(previousWord)) continue;
      }
      current++;
      continue;
    }
    previousWord = t;
    tokens.push(TOKEN_ALIASES.get(t) ?? t);
    clause.push(current);
  }
  return { tokens, clause };
}

// ── Term compilation ───────────────────────────────────────────────────

interface TokenTerm {
  readonly kind: 'tokens';
  readonly term: string;
  readonly source: ExclusionSource;
  readonly tokens: readonly string[];
  /** Last token is a prefix (`lead*`). */
  readonly prefix: boolean;
}

interface SubstringTerm {
  readonly kind: 'substring';
  readonly term: string;
  readonly source: ExclusionSource;
  readonly needle: string;
}

type CompiledTerm = TokenTerm | SubstringTerm;

class ExclusionScope {
  /** Exact-first-token index. */
  readonly byFirst = new Map<string, TokenTerm[]>();
  /** Single-token prefix terms (at most a few dozen per scope). */
  readonly prefixTerms: TokenTerm[] = [];
  readonly substrings: SubstringTerm[] = [];
  private readonly keys = new Set<string>();

  get size(): number {
    return this.keys.size;
  }

  add(term: CompiledTerm): void {
    const key =
      term.kind === 'substring'
        ? `s:${term.needle}`
        : `t:${term.tokens.join(' ')}${term.prefix ? '*' : ''}`;
    if (this.keys.has(key)) return;
    this.keys.add(key);
    if (term.kind === 'substring') {
      this.substrings.push(term);
    } else if (term.prefix && term.tokens.length === 1) {
      this.prefixTerms.push(term);
    } else {
      const bucket = this.byFirst.get(term.tokens[0]);
      if (bucket) bucket.push(term);
      else this.byFirst.set(term.tokens[0], [term]);
    }
  }
}

interface CompiledScopes {
  /** title ∪ keywords ∪ presets */
  readonly title: ExclusionScope;
  /** keywords ∪ presets */
  readonly description: ExclusionScope;
}

/** The term indexes behind each compiled spec, kept off the public object. */
const SCOPES = new WeakMap<CompiledJobExclusions, CompiledScopes>();
const EMPTY_SCOPES: CompiledScopes = { title: new ExclusionScope(), description: new ExclusionScope() };

/**
 * A compiled {@link JobExclusionSpec}. Build once per request with
 * {@link compileJobExclusions}; reuse for every job.
 */
export class CompiledJobExclusions {
  /** `false` when both scopes are empty: filtering is then a no-op. */
  readonly active: boolean;
  /** Terms that passed validation but compiled to nothing. */
  readonly ignored: readonly IgnoredExclusionTerm[];
  /** Number of distinct compiled terms (the title scope is a superset of the description scope). */
  readonly termCount: number;

  constructor(active: boolean, termCount: number, ignored: readonly IgnoredExclusionTerm[]) {
    this.active = active;
    this.termCount = termCount;
    this.ignored = Object.freeze([...ignored]);
  }
}

function scopesOf(compiled: CompiledJobExclusions): CompiledScopes {
  return SCOPES.get(compiled) ?? EMPTY_SCOPES;
}

function describeRaw(raw: unknown): string {
  const s = typeof raw === 'string' ? raw : String(raw);
  return s.length > MAX_EXCLUSION_TERM_LENGTH ? s.slice(0, MAX_EXCLUSION_TERM_LENGTH) : s;
}

function compileTerm(raw: unknown, source: ExclusionSource, ignored: IgnoredExclusionTerm[]): CompiledTerm | null {
  if (typeof raw !== 'string') {
    ignored.push({ term: describeRaw(raw), reason: 'empty' });
    return null;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    ignored.push({ term: raw, reason: 'empty' });
    return null;
  }
  if (trimmed.length > MAX_EXCLUSION_TERM_LENGTH) {
    ignored.push({ term: describeRaw(trimmed), reason: 'too_long' });
    return null;
  }
  let body = trimmed;
  const prefix = body.endsWith('*');
  while (body.endsWith('*')) body = body.slice(0, -1);

  const folded = foldCase(body);
  const tokens = tokenize(folded).tokens;
  if (tokens.length === 0) {
    ignored.push({ term: trimmed, reason: 'empty' });
    return null;
  }
  if (tokens.length > MAX_EXCLUSION_TERM_TOKENS) {
    ignored.push({ term: trimmed, reason: 'too_many_tokens' });
    return null;
  }
  if (SEPARATORLESS_SCRIPT.test(folded)) {
    return { kind: 'substring', term: trimmed, source, needle: tokens.join(' ') };
  }
  if (prefix && tokens[tokens.length - 1].length < MIN_EXCLUSION_PREFIX_LENGTH) {
    ignored.push({ term: trimmed, reason: 'prefix_too_short' });
    return null;
  }
  return { kind: 'tokens', term: trimmed, source, tokens, prefix };
}

function compileList(
  list: readonly unknown[] | null | undefined,
  source: ExclusionSource,
  ignored: IgnoredExclusionTerm[],
): CompiledTerm[] {
  if (!Array.isArray(list)) return [];
  const out: CompiledTerm[] = [];
  list.forEach((raw, index) => {
    if (index >= MAX_EXCLUSION_TERMS) {
      ignored.push({ term: describeRaw(raw), reason: 'over_limit' });
      return;
    }
    const term = compileTerm(raw, source, ignored);
    if (term) out.push(term);
  });
  return out;
}

const KNOWN_PRESETS = new Set<string>(Object.values(ExclusionPreset));

function compilePresets(
  presets: readonly unknown[] | null | undefined,
  ignored: IgnoredExclusionTerm[],
): CompiledTerm[] {
  if (!Array.isArray(presets)) return [];
  const out: CompiledTerm[] = [];
  const done = new Set<string>();
  for (const raw of presets) {
    const name = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    if (!KNOWN_PRESETS.has(name)) {
      ignored.push({ term: describeRaw(raw), reason: 'unknown_preset' });
      continue;
    }
    if (done.has(name)) continue;
    done.add(name);
    const preset = name as ExclusionPreset;
    for (const phrase of EXCLUSION_PRESET_TERMS[preset]) {
      const term = compileTerm(phrase, `preset:${preset}`, ignored);
      if (term) out.push(term);
    }
  }
  return out;
}

/**
 * Compile a spec into two scopes: the title scope (`titleTerms` ∪ `keywords`
 * ∪ preset terms) and the description scope (`keywords` ∪ preset terms).
 * Identical token sequences are de-duplicated per scope; the first source
 * wins. Bad terms are collected in `ignored`, never thrown.
 */
export function compileJobExclusions(spec?: JobExclusionSpec | null): CompiledJobExclusions {
  const ignored: IgnoredExclusionTerm[] = [];
  const titleTerms = compileList(spec?.titleTerms, 'title_terms', ignored);
  const keywords = compileList(spec?.keywords, 'keywords', ignored);
  const presetTerms = compilePresets(spec?.presets, ignored);

  const titleScope = new ExclusionScope();
  const descriptionScope = new ExclusionScope();
  for (const t of titleTerms) titleScope.add(t);
  for (const t of keywords) {
    titleScope.add(t);
    descriptionScope.add(t);
  }
  for (const t of presetTerms) {
    titleScope.add(t);
    descriptionScope.add(t);
  }
  const compiled = new CompiledJobExclusions(
    titleScope.size > 0 || descriptionScope.size > 0,
    titleScope.size,
    ignored,
  );
  SCOPES.set(compiled, { title: titleScope, description: descriptionScope });
  return compiled;
}

// ── Matching ───────────────────────────────────────────────────────────

/** Index of the last matched token, or -1. Every token must share the start's clause. */
function matchAt(doc: TokenizedText, start: number, term: TokenTerm): number {
  const { tokens, clause } = doc;
  const n = term.tokens.length;
  if (start + n > tokens.length) return -1;
  const clauseId = clause[start];
  for (let k = 0; k < n; k++) {
    const idx = start + k;
    if (clause[idx] !== clauseId) return -1;
    const want = term.tokens[k];
    const got = tokens[idx];
    const ok = term.prefix && k === n - 1 ? got.startsWith(want) : got === want;
    if (!ok) return -1;
  }
  return start + n - 1;
}

/** `not`, or the `t` of a split contraction ("isn't"). */
function isNotAt(doc: TokenizedText, j: number): boolean {
  const tok = doc.tokens[j];
  if (tok === 'not') return true;
  return tok === 't' && j > 0 && doc.clause[j - 1] === doc.clause[j] && CONTRACTION_STEMS.has(doc.tokens[j - 1]);
}

/**
 * A match is negated when a negator sits within the window before it, or when
 * it is followed by "not required" / "none" within the window after it — all
 * inside the same clause.
 */
function isNegated(doc: TokenizedText, start: number, end: number): boolean {
  const { tokens, clause } = doc;
  const clauseId = clause[start];
  for (let j = start - 1; j >= 0 && j >= start - EXCLUSION_NEGATION_WINDOW; j--) {
    if (clause[j] !== clauseId) break;
    if (NEGATORS.has(tokens[j]) || isNotAt(doc, j)) return true;
  }
  const last = Math.min(tokens.length - 1, end + EXCLUSION_NEGATION_WINDOW);
  for (let j = end + 1; j <= last; j++) {
    if (clause[j] !== clauseId) break;
    if (TRAILING_NEGATIONS.has(tokens[j])) return true;
    if (
      isNotAt(doc, j) &&
      j + 1 < tokens.length &&
      clause[j + 1] === clauseId &&
      REQUIREMENT_WORDS.has(tokens[j + 1])
    ) {
      return true;
    }
  }
  return false;
}

/**
 * First non-negated match by text position, then term order. Substring terms
 * (separator-less scripts) are checked after token terms, earliest position
 * first, and carry no negation handling in this version.
 */
function matchScope(doc: TokenizedText, scope: ExclusionScope): CompiledTerm | null {
  const { tokens } = doc;
  for (let i = 0; i < tokens.length; i++) {
    const candidates = scope.byFirst.get(tokens[i]);
    if (candidates) {
      for (const term of candidates) {
        const end = matchAt(doc, i, term);
        if (end >= 0 && !isNegated(doc, i, end)) return term;
      }
    }
    for (const term of scope.prefixTerms) {
      if (tokens[i].startsWith(term.tokens[0]) && !isNegated(doc, i, i)) return term;
    }
  }
  if (scope.substrings.length > 0) {
    const joined = tokens.join(' ');
    let best: SubstringTerm | null = null;
    let bestAt = Number.POSITIVE_INFINITY;
    for (const term of scope.substrings) {
      const at = joined.indexOf(term.needle);
      if (at >= 0 && at < bestAt) {
        best = term;
        bestAt = at;
      }
    }
    return best;
  }
  return null;
}

function matchField(value: unknown, scope: ExclusionScope): CompiledTerm | null {
  if (scope.size === 0 || typeof value !== 'string' || value.length === 0) return null;
  return matchScope(tokenize(prepareText(value)), scope);
}

/**
 * Why `job` is excluded, or `null` to keep it. The title is checked first; the
 * description is read (and tokenised) only when the title did not match and
 * the description scope is non-empty, so title-only filters never touch
 * descriptions. `null`/non-string fields count as empty.
 */
export function matchJobExclusion(
  job: { title?: unknown; description?: unknown } | null | undefined,
  compiled: CompiledJobExclusions,
): ExclusionMatch | null {
  if (!compiled.active || !job) return null;
  const scopes = scopesOf(compiled);
  const inTitle = matchField(job.title, scopes.title);
  if (inTitle) return { term: inTitle.term, source: inTitle.source, field: 'title' };
  if (scopes.description.size === 0) return null;
  const inDescription = matchField(job.description, scopes.description);
  if (inDescription) return { term: inDescription.term, source: inDescription.source, field: 'description' };
  return null;
}

/** Aggregate matches into {@link JobExclusionMetrics}. `byTerm` is most frequent first. */
export function buildExclusionMetrics(
  compiled: CompiledJobExclusions,
  matches: readonly ExclusionMatch[],
  excludedCount: number = matches.length,
): JobExclusionMetrics {
  const counts = new Map<string, { term: string; source: ExclusionSource; count: number }>();
  for (const m of matches) {
    const key = `${m.source}\u0000${m.term}`;
    const entry = counts.get(key);
    if (entry) entry.count++;
    else counts.set(key, { term: m.term, source: m.source, count: 1 });
  }
  // Array.prototype.sort is stable, so equal counts keep first-seen order.
  const byTerm = [...counts.values()].sort((a, b) => b.count - a.count);
  return {
    excludedCount,
    excludedRawCount: matches.length,
    byTerm,
    ignoredTerms: [...compiled.ignored],
  };
}

/**
 * Filter `jobs`. An inactive spec (absent, empty, all-blank) returns every job
 * in its original order.
 */
export function applyJobExclusions<T extends { title?: unknown; description?: unknown }>(
  jobs: readonly T[],
  specOrCompiled?: JobExclusionSpec | CompiledJobExclusions | null,
): { kept: T[]; excluded: { job: T; match: ExclusionMatch }[]; metrics: JobExclusionMetrics } {
  const compiled =
    specOrCompiled instanceof CompiledJobExclusions ? specOrCompiled : compileJobExclusions(specOrCompiled);
  if (!compiled.active) {
    return { kept: [...jobs], excluded: [], metrics: buildExclusionMetrics(compiled, []) };
  }
  const kept: T[] = [];
  const excluded: { job: T; match: ExclusionMatch }[] = [];
  for (const job of jobs) {
    const match = matchJobExclusion(job, compiled);
    if (match) excluded.push({ job, match });
    else kept.push(job);
  }
  return {
    kept,
    excluded,
    metrics: buildExclusionMetrics(
      compiled,
      excluded.map((e) => e.match),
    ),
  };
}

/** The exclusion fields of a search input, as a {@link JobExclusionSpec}. */
export function exclusionSpecFromInput(
  input:
    | {
        excludeTitleTerms?: readonly string[] | null;
        excludeKeywords?: readonly string[] | null;
        excludePresets?: readonly (ExclusionPreset | string)[] | null;
      }
    | null
    | undefined,
): JobExclusionSpec {
  return {
    titleTerms: input?.excludeTitleTerms ?? undefined,
    keywords: input?.excludeKeywords ?? undefined,
    presets: input?.excludePresets ?? undefined,
  };
}

/**
 * `true` when the caller supplied at least one exclusion field (even an empty
 * one). Responses carry exclusion metrics exactly when this is true, so an
 * unfiltered response stays byte-identical to the pre-Spec-1700 shape.
 */
export function hasExclusionInput(
  input: { excludeTitleTerms?: unknown; excludeKeywords?: unknown; excludePresets?: unknown } | null | undefined,
): boolean {
  if (!input) return false;
  return EXCLUSION_INPUT_KEYS.some((key) => input[key] !== undefined && input[key] !== null);
}
