import { CompensationDto, CompensationInterval, looksLikeChallenge } from '@ever-jobs/models';
import {
  REMOTEOK_GENERIC_TOKENS,
  REMOTEOK_HOSTS,
  REMOTEOK_MAX_SALARY_SPREAD,
  REMOTEOK_MAX_SEARCH_TOKENS,
  REMOTEOK_MIN_PLAUSIBLE_SALARY,
  REMOTEOK_REMOTE_ALIASES,
  REMOTEOK_STOPWORDS,
} from './remoteok.constants';
import { RemoteOkJob } from './remoteok.types';

/**
 * Pure helpers for the RemoteOK source (Spec 1707): text repair, search
 * tokens and ranking, URL and location tidying, salary plausibility, and feed
 * validation. No Nest, no I/O, no clock.
 */

// -- Double-encoded UTF-8 repair ---------------------------------------------
//
// The API serialises UTF-8 bytes as if they were Latin-1 code points, so
// U+2122 arrives as U+00E2 U+0084 U+00A2 and U+00F3 as U+00C3 U+00B3. Every
// such run is a UTF-8 lead byte (U+00C2-U+00F4) followed by continuation bytes
// (U+0080-U+00BF), a pairing that does not occur in real prose.

/** A lead+continuation pair or a stray C1 control: the string needs repair. */
const MOJIBAKE_FLAG = /[\xC2-\xF4][\u0080-\xBF]|[\u0080-\u009F]/;
/** One complete 2-, 3- or 4-byte UTF-8 sequence spelled as Latin-1. */
const MOJIBAKE_SEQUENCE =
  /[\xC2-\xDF][\u0080-\xBF]|[\xE0-\xEF][\u0080-\xBF]{2}|[\xF0-\xF4][\u0080-\xBF]{3}/g;
/**
 * A sequence cut off at the very end of the field: a bare U+00C2 (a cut
 * NBSP or middle dot), a 3-byte lead with one continuation, or a 4-byte lead
 * with one or two. A bare accented letter is deliberately not matched, so a
 * correctly encoded trailing letter in a mixed string survives. Matched on
 * the raw string: after decoding it would eat a repaired trailing letter.
 */
const MOJIBAKE_TRUNCATED_TAIL =
  /(?:\xC2|[\xE0-\xEF][\u0080-\xBF]|[\xF0-\xF4][\u0080-\xBF]{1,2})$/;
const C1_CONTROLS = /[\u0080-\u009F]/g;
/** Two passes: triple-encoded runs were seen live. */
const MAX_REPAIR_PASSES = 2;
const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true });

function decodeSequence(run: string): string {
  try {
    return STRICT_UTF8.decode(Buffer.from(run, 'latin1'));
  } catch {
    return run;
  }
}

/**
 * Repair UTF-8 text that was decoded as Latin-1 (once or twice). Works per
 * sequence, so correctly encoded characters in the same string are left
 * alone; a run that is not valid UTF-8 is kept verbatim. Clean text is
 * returned unchanged (same reference). Idempotent.
 */
export function repairMojibake(text: string): string;
export function repairMojibake(text: string | null | undefined): string | null | undefined;
export function repairMojibake(text: string | null | undefined): string | null | undefined {
  if (!text || !MOJIBAKE_FLAG.test(text)) return text;
  let out = text.replace(MOJIBAKE_TRUNCATED_TAIL, '');
  for (let pass = 0; pass < MAX_REPAIR_PASSES; pass++) {
    const next = out.replace(MOJIBAKE_SEQUENCE, decodeSequence);
    if (next === out) break;
    out = next;
  }
  return out.replace(C1_CONTROLS, '');
}

/** Characters stripped from the end of a title (a cut "Agent \xB7" and the like). */
const TITLE_TRAILING_SEPARATORS = new Set([
  ' ', '\t', '\n', '\r', '\f', '\v', '\xA0',
  '\xB7', '\u{2022}', '|', ',', ':', ';', '-', '\u{2013}', '\u{2014}',
]);

/** Collapse every whitespace run (newlines included) to one space and trim. */
export function collapseWhitespace(text: string | null | undefined): string {
  return typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
}

/**
 * Collapse whitespace (titles arrive as `Python\n Developer`) and trim
 * trailing separator runs. A loop from the end rather than a `[...]+$` regex,
 * which rescans a long inner run from every start position.
 */
export function cleanTitle(title: string | null | undefined): string {
  const collapsed = collapseWhitespace(title);
  let end = collapsed.length;
  while (end > 0 && TITLE_TRAILING_SEPARATORS.has(collapsed[end - 1])) end--;
  return collapsed.slice(0, end).trim();
}

// -- Search tokens and ranking -----------------------------------------------

const COMBINING_MARKS = /[\u{300}-\u{36F}]/gu;
const TOKEN = /[a-z0-9][a-z0-9+#.]*/g;
/** A token usable as a `?tag=` value: letters or digits, at least one letter. */
const TAG_SLUG = /^(?=[a-z0-9-]*[a-z])[a-z0-9][a-z0-9-]{0,39}$/;

/** Lower-case and strip diacritics, so `Caf\xE9` and `cafe` compare equal. */
export function foldText(text: string | null | undefined): string {
  if (!text) return '';
  return text.normalize('NFKD').replace(COMBINING_MARKS, '').toLowerCase();
}

/**
 * Split a search term into distinct, folded tokens: `+`, `#` and inner `.`
 * are kept (`c++`, `c#`, `node.js`), a trailing `.` is dropped, and stopwords
 * go. Capped at {@link REMOTEOK_MAX_SEARCH_TOKENS}.
 */
export function tokenizeSearchTerm(term: string | null | undefined): string[] {
  const raw = foldText(term).match(TOKEN) ?? [];
  const tokens: string[] = [];
  for (const candidate of raw) {
    const token = candidate.replace(/\.+$/, '');
    if (!token || REMOTEOK_STOPWORDS.has(token) || tokens.includes(token)) continue;
    tokens.push(token);
    if (tokens.length >= REMOTEOK_MAX_SEARCH_TOKENS) break;
  }
  return tokens;
}

/**
 * The token to request as a tag feed: the longest one that is neither a
 * generic role/seniority word nor unsafe as a slug (`c++`, `node.js` stay
 * local-only). Earliest wins a tie. `null` when nothing qualifies.
 */
export function pickTagSeed(tokens: readonly string[]): string | null {
  let seed: string | null = null;
  for (const token of tokens) {
    if (REMOTEOK_GENERIC_TOKENS.has(token) || !TAG_SLUG.test(token)) continue;
    if (seed === null || token.length > seed.length) seed = token;
  }
  return seed;
}

const TOKEN_PATTERNS = new Map<string, RegExp>();
const MAX_CACHED_TOKEN_PATTERNS = 512;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function tokenPattern(token: string): RegExp {
  let pattern = TOKEN_PATTERNS.get(token);
  if (!pattern) {
    if (TOKEN_PATTERNS.size >= MAX_CACHED_TOKEN_PATTERNS) TOKEN_PATTERNS.clear();
    pattern = new RegExp(`(?<![a-z0-9])${escapeRegExp(token)}(?:e?s)?(?![a-z0-9])`);
    TOKEN_PATTERNS.set(token, pattern);
  }
  return pattern;
}

/**
 * Whole-word token test on folded text: `java` does not match `javascript`,
 * `go` does not match `google`, and a plural `s` / `es` is allowed.
 */
export function hasToken(haystack: string, token: string): boolean {
  if (!token) return false;
  return tokenPattern(token).test(haystack);
}

/** Folded text of one job, per match tier. */
export interface MatchFields {
  /** Position only. */
  title: string;
  /** Position, company and plain-text description. */
  core: string;
  /** Core plus the tags. */
  all: string;
}

const FIELD_SEPARATOR = ' \n ';

/** Build the folded match fields from already-repaired text. */
export function buildMatchFields(
  title: string,
  company: string,
  plainDescription: string,
  tags: readonly string[],
): MatchFields {
  const foldedTitle = foldText(title);
  const core = [foldedTitle, foldText(company), foldText(plainDescription)].join(FIELD_SEPARATOR);
  return { title: foldedTitle, core, all: `${core}${FIELD_SEPARATOR}${foldText(tags.join(' , '))}` };
}

/**
 * How strongly a job matches every token: `0` all in the title (or no
 * tokens), `1` all in title/company/description, `2` only with the help of
 * tags (weak evidence: the board tags very loosely), `null` not a match.
 */
export function matchTier(fields: MatchFields, tokens: readonly string[]): 0 | 1 | 2 | null {
  if (tokens.length === 0) return 0;
  if (tokens.every((t) => hasToken(fields.title, t))) return 0;
  if (tokens.every((t) => hasToken(fields.core, t))) return 1;
  if (tokens.every((t) => hasToken(fields.all, t))) return 2;
  return null;
}

/**
 * The pre-Spec-1707 filter, kept for `EVER_JOBS_REMOTEOK_LEGACY=search`: the
 * whole lower-cased phrase as a substring of the title or of any tag.
 */
export function legacyPhraseMatch(title: string, tags: readonly string[], term: string): boolean {
  const phrase = term.toLowerCase();
  return title.toLowerCase().includes(phrase) || tags.some((tag) => tag.toLowerCase().includes(phrase));
}

// -- Locations ---------------------------------------------------------------

/**
 * Tidy a free-text location: trim the comma-separated parts, drop empty ones
 * (`Brasil, `), collapse adjacent repeats (`Austin, Austin, Texas`), and map a
 * bare remote word in any of the board's languages to `Remote`.
 */
export function tidyLocation(location: string | null | undefined): string | null {
  if (typeof location !== 'string') return null;
  const parts: string[] = [];
  for (const part of location.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const previous = parts[parts.length - 1];
    if (previous !== undefined && previous.toLowerCase() === trimmed.toLowerCase()) continue;
    parts.push(trimmed);
  }
  const joined = parts.join(', ');
  if (!joined) return null;
  return REMOTEOK_REMOTE_ALIASES.test(joined) ? 'Remote' : joined;
}

// -- URLs --------------------------------------------------------------------

/**
 * An http(s) URL, normalised (host lower-cased); a relative one is resolved
 * against `base` when given. Anything else (other schemes, junk) is `null`.
 */
export function normalizeUrl(raw: unknown, base?: string): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!text) return null;
  try {
    const url = base ? new URL(text, base) : new URL(text);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Whether a URL is on the board's own hosts (or a subdomain of one). */
export function isBoardHost(url: string | null | undefined): boolean {
  if (!url) return false;
  const host = hostOf(url);
  if (!host) return false;
  return REMOTEOK_HOSTS.some((board) => host === board || host.endsWith(`.${board}`));
}

/**
 * Whether a board URL is an index page (`/`, `/remote-jobs/`) rather than one
 * job. The feed sends `https://remoteOK.com/remote-jobs/` for a job with an
 * empty slug.
 */
export function isBoardIndexUrl(url: string | null | undefined): boolean {
  if (!url || !isBoardHost(url)) return false;
  try {
    const path = new URL(url).pathname.replace(/\/+$/, '');
    return path === '' || path === '/remote-jobs';
  } catch {
    return false;
  }
}

const SAFE_SLUG = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,300}$/;
const NUMERIC_ID = /^\d{1,20}$/;

/**
 * The job's page on the board: the feed's `url` when it names one job, else
 * `/remote-jobs/<slug>`, else `/remote-jobs/<id>` (the board redirects a bare
 * numeric id to the full slug URL; verified live 2026-09-25). `null` when
 * nothing usable is left.
 */
export function resolveJobUrl(entry: Pick<RemoteOkJob, 'url' | 'slug' | 'id'>, baseUrl: string): string | null {
  const url = normalizeUrl(entry.url, baseUrl);
  if (url && !isBoardIndexUrl(url)) return url;
  const slug = typeof entry.slug === 'string' ? entry.slug.trim() : '';
  if (SAFE_SLUG.test(slug)) return `${baseUrl}/remote-jobs/${slug}`;
  const id = String(entry.id ?? '').trim();
  if (NUMERIC_ID.test(id)) return `${baseUrl}/remote-jobs/${id}`;
  return null;
}

/**
 * `applyUrl` is the feed's `apply_url` (or the job page when that is missing
 * or an index page); `jobUrlDirect` is the same link only when it leaves the
 * board, because a board page is not a direct employer link.
 */
export function resolveApplyUrls(
  applyUrl: unknown,
  jobUrl: string,
  baseUrl?: string,
): { applyUrl: string; jobUrlDirect: string | null } {
  const normalized = normalizeUrl(applyUrl, baseUrl);
  const apply = normalized && !isBoardIndexUrl(normalized) ? normalized : jobUrl;
  return { applyUrl: apply, jobUrlDirect: isBoardHost(apply) ? null : apply };
}

// -- Salary ------------------------------------------------------------------

function positiveAmount(value: unknown): number | null {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * A yearly USD compensation when the feed's pair is plausible, else `null`
 * (which leaves the description-based salary fallback free to run). One-sided
 * values are kept. Rejected: inverted pairs, figures under
 * {@link REMOTEOK_MIN_PLAUSIBLE_SALARY} (hourly or thousands? cannot tell),
 * and spreads over {@link REMOTEOK_MAX_SALARY_SPREAD}x (placeholders).
 */
export function plausibleCompensation(minRaw: unknown, maxRaw: unknown): CompensationDto | null {
  const min = positiveAmount(minRaw);
  const max = positiveAmount(maxRaw);
  if (min === null && max === null) return null;
  if (min !== null && max !== null && max < min) return null;
  if ((max ?? min ?? 0) < REMOTEOK_MIN_PLAUSIBLE_SALARY) return null;
  if (min !== null && max !== null && max / min > REMOTEOK_MAX_SALARY_SPREAD) return null;
  return new CompensationDto({
    interval: CompensationInterval.YEARLY,
    ...(min !== null ? { minAmount: min } : {}),
    ...(max !== null ? { maxAmount: max } : {}),
    currency: 'USD',
  });
}

/** The pre-Spec-1707 rule: both bounds above zero, emitted as-is. */
export function legacyCompensation(minRaw: unknown, maxRaw: unknown): CompensationDto | null {
  if (typeof minRaw !== 'number' || typeof maxRaw !== 'number' || !(minRaw > 0) || !(maxRaw > 0)) {
    return null;
  }
  return new CompensationDto({
    interval: CompensationInterval.YEARLY,
    minAmount: minRaw,
    maxAmount: maxRaw,
    currency: 'USD',
  });
}

// -- Feed payload ------------------------------------------------------------

/** A job row: an `id` (string or number) and a string `position`. Skips the metadata row by shape. */
export function isJobEntry(value: unknown): value is RemoteOkJob {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as { id?: unknown; position?: unknown };
  const idOk =
    (typeof row.id === 'string' && row.id.trim() !== '') ||
    (typeof row.id === 'number' && Number.isFinite(row.id));
  return idOk && typeof row.position === 'string';
}

const SNIPPET_LENGTH = 120;

/**
 * Validate a feed response body and return its job rows. Throws for a string
 * body (with `challenge` in the message when it is a bot interstitial, so the
 * error classifies as `blocked`) and for any non-array.
 */
export function parseFeedPayload(data: unknown): RemoteOkJob[] {
  if (typeof data === 'string') {
    const snippet = data.replace(/\s+/g, ' ').trim().slice(0, SNIPPET_LENGTH);
    if (looksLikeChallenge(data)) {
      throw new Error(`RemoteOK returned a bot challenge instead of JSON: ${snippet}`);
    }
    throw new Error(`RemoteOK returned non-JSON: ${snippet}`);
  }
  if (!Array.isArray(data)) {
    throw new Error('RemoteOK returned a non-array payload');
  }
  return data.filter(isJobEntry);
}

// -- Legacy switch -----------------------------------------------------------

export type RemoteOkLegacyPart = 'search' | 'text' | 'urls' | 'salary' | 'location' | 'ua';

export const REMOTEOK_LEGACY_PARTS: readonly RemoteOkLegacyPart[] = [
  'search',
  'text',
  'urls',
  'salary',
  'location',
  'ua',
];

export interface RemoteOkLegacyMode {
  parts: ReadonlySet<RemoteOkLegacyPart>;
  /** Tokens that named no part (reported, otherwise ignored). */
  unknown: string[];
}

const ALL_PARTS = new Set(['true', '1', 'yes', 'on', 'all']);
const NO_PARTS = new Set(['false', '0', 'no', 'off', 'none']);

/** Parse `EVER_JOBS_REMOTEOK_LEGACY` (see the constant's doc for the grammar). */
export function parseLegacyMode(raw: string | null | undefined): RemoteOkLegacyMode {
  const parts = new Set<RemoteOkLegacyPart>();
  const unknown: string[] = [];
  const text = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!text || NO_PARTS.has(text)) return { parts, unknown };
  if (ALL_PARTS.has(text)) return { parts: new Set(REMOTEOK_LEGACY_PARTS), unknown };
  for (const token of text.split(/[\s,]+/)) {
    if (!token) continue;
    if ((REMOTEOK_LEGACY_PARTS as readonly string[]).includes(token)) {
      parts.add(token as RemoteOkLegacyPart);
    } else if (ALL_PARTS.has(token)) {
      REMOTEOK_LEGACY_PARTS.forEach((part) => parts.add(part));
    } else {
      unknown.push(token.slice(0, 40));
    }
  }
  return { parts, unknown };
}
