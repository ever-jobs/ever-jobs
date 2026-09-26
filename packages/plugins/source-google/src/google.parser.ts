/**
 * Pure readers for the Google Jobs page (Spec 1704). No I/O.
 *
 * The page carries one inline JSON record per job, each the value of a
 * 9-digit key: `"<key>":[<title>, <company>, <location>, [[<url>, ...], ...], ...]`.
 * Every field of a row comes out of the same record, so a title can never be
 * paired with another job's URL (the defect of the pre-Spec-1704 parser, which
 * collected titles and URLs into two unrelated lists and zipped them by index).
 */
import * as cheerio from 'cheerio';
import { parseLocationList } from '@ever-jobs/common';
import { JobPostDto, LocationDto, Site } from '@ever-jobs/models';
import {
  GOOGLE_JOB_PAYLOAD_KEYS,
  GOOGLE_MAX_KEY_CANDIDATES,
  GOOGLE_MAX_RECORD_CHARS,
  GOOGLE_MAX_SCAN_CHARS,
} from './google.constants';

/** Record indices (0-based) the plugin reads. */
export const GOOGLE_RECORD_INDEX = {
  title: 0,
  company: 1,
  location: 2,
  links: 3,
  stableId: 28,
} as const;

/** A record is at least this long; shorter arrays are not job records. */
const MIN_RECORD_LENGTH = 13;

const HTTP_URL_RE = /^https?:\/\//i;

/** Whole-label spellings meaning "no fixed site". Not places. */
const REMOTE_ONLY_LABEL_RE = /^\s*(?:anywhere|remote|work from home|wfh)\s*$/i;

/** A remote qualifier anywhere in a location label. */
const REMOTE_MENTION_RE = /\bremote\b|work from home|\bwfh\b/i;

const BACKSLASH = 92;
const QUOTE = 34;
const OPEN_BRACKET = 91;
const CLOSE_BRACKET = 93;

export interface GoogleScanOptions {
  /** Keys tried before the shape fallback. Default {@link GOOGLE_JOB_PAYLOAD_KEYS}. */
  knownKeys?: readonly string[];
  /** Per-record scan limit. Default {@link GOOGLE_MAX_RECORD_CHARS}. */
  maxRecordChars?: number;
  /** Per-page scan budget. Default {@link GOOGLE_MAX_SCAN_CHARS}. */
  maxScanChars?: number;
  /** Most key candidates inspected. Default {@link GOOGLE_MAX_KEY_CANDIDATES}. */
  maxCandidates?: number;
}

export interface GoogleRecordScan {
  /** Job-shaped records in page order. */
  records: unknown[][];
  /** Distinct keys the records were found under. */
  keys: string[];
  /**
   * True when none of the known keys produced a record and the records came
   * from the shape fallback: the caller should log the key so it can be added
   * to {@link GOOGLE_JOB_PAYLOAD_KEYS}.
   */
  viaFallback: boolean;
}

/**
 * Index of the `]` closing the array that opens at `start`, or -1 when `start`
 * is not `[`, the array does not close within `maxChars`, or the text ends
 * first. Tracks JSON string and escape state, so brackets inside strings do
 * not count.
 */
export function findArrayEnd(text: string, start: number, maxChars: number = GOOGLE_MAX_RECORD_CHARS): number {
  if (start < 0 || start >= text.length || text.charCodeAt(start) !== OPEN_BRACKET) return -1;
  const limit = Math.min(text.length, start + Math.max(0, maxChars));
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < limit; i++) {
    const ch = text.charCodeAt(i);
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === BACKSLASH) escaped = true;
      else if (ch === QUOTE) inString = false;
      continue;
    }
    if (ch === QUOTE) inString = true;
    else if (ch === OPEN_BRACKET) depth++;
    else if (ch === CLOSE_BRACKET) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * The balanced JSON array opening at `start`, as text, or `null`. The slice is
 * bounded by bracket depth rather than by any fixed run of closing brackets,
 * so a change in the wrapper around a record does not break extraction.
 */
export function extractBalancedArray(
  text: string,
  start: number,
  maxChars: number = GOOGLE_MAX_RECORD_CHARS,
): string | null {
  const end = findArrayEnd(text, start, maxChars);
  return end < 0 ? null : text.slice(start, end + 1);
}

function nonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** The primary link of a record: `[3][0][0]`, when it is an http(s) URL. */
function primaryLink(record: unknown[]): string | null {
  const links = record[GOOGLE_RECORD_INDEX.links];
  if (!Array.isArray(links)) return null;
  const first = links[0];
  if (!Array.isArray(first)) return null;
  const url = first[0];
  if (typeof url !== 'string') return null;
  const trimmed = url.trim();
  return HTTP_URL_RE.test(trimmed) ? trimmed : null;
}

/**
 * Record shape: an array of at least 13 entries whose title, company and
 * location label are non-blank strings and whose `[3][0][0]` is an http(s)
 * URL. A record without a URL fails the check and is skipped, never given a
 * made-up search link. The same predicate guards the known-key path and the
 * fallback, and it accepts the record as it really starts (`["<title>", …`).
 */
export function isJobRecord(value: unknown): value is unknown[] {
  if (!Array.isArray(value) || value.length < MIN_RECORD_LENGTH) return false;
  if (!nonBlankString(value[GOOGLE_RECORD_INDEX.title])) return false;
  if (!nonBlankString(value[GOOGLE_RECORD_INDEX.company])) return false;
  if (!nonBlankString(value[GOOGLE_RECORD_INDEX.location])) return false;
  return primaryLink(value) !== null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function scanKeyedRecords(
  text: string,
  keyRe: RegExp,
  maxRecordChars: number,
  maxScanChars: number,
  maxCandidates: number,
): { records: unknown[][]; keys: string[] } {
  const records: unknown[][] = [];
  const keys: string[] = [];
  let budget = maxScanChars;
  let candidates = 0;
  /** end of the last accepted record: keys inside it are its own fields */
  let coveredUntil = -1;

  for (const match of text.matchAll(keyRe)) {
    if (candidates >= maxCandidates || budget <= 0) break;
    const index = match.index ?? 0;
    if (index <= coveredUntil) continue;
    candidates++;
    const open = index + match[0].length - 1;
    const window = Math.min(maxRecordChars, budget);
    const end = findArrayEnd(text, open, window);
    budget -= end < 0 ? Math.min(window, text.length - open) : end - open + 1;
    if (end < 0) continue;
    let value: unknown;
    try {
      value = JSON.parse(text.slice(open, end + 1));
    } catch {
      continue;
    }
    if (!isJobRecord(value)) continue;
    records.push(value);
    coveredUntil = end;
    if (!keys.includes(match[1])) keys.push(match[1]);
  }
  return { records, keys };
}

/**
 * Every job record on a page. Known keys first; when none of them yields a
 * record, any 9-digit key whose value has the record shape.
 */
export function findJobRecords(text: string, options: GoogleScanOptions = {}): GoogleRecordScan {
  if (!text) return { records: [], keys: [], viaFallback: false };
  const knownKeys = (options.knownKeys ?? GOOGLE_JOB_PAYLOAD_KEYS).filter((k) => /^\d+$/.test(k));
  const maxRecordChars = options.maxRecordChars ?? GOOGLE_MAX_RECORD_CHARS;
  const maxScanChars = options.maxScanChars ?? GOOGLE_MAX_SCAN_CHARS;
  const maxCandidates = options.maxCandidates ?? GOOGLE_MAX_KEY_CANDIDATES;

  if (knownKeys.length > 0) {
    const knownRe = new RegExp(`"(${knownKeys.map(escapeRegExp).join('|')})"\\s*:\\s*\\[`, 'g');
    const known = scanKeyedRecords(text, knownRe, maxRecordChars, maxScanChars, maxCandidates);
    if (known.records.length > 0) return { ...known, viaFallback: false };
  }

  const fallback = scanKeyedRecords(text, /"(\d{9})"\s*:\s*\[/g, maxRecordChars, maxScanChars, maxCandidates);
  return { ...fallback, viaFallback: fallback.records.length > 0 };
}

/**
 * The forward cursor (`data-async-fc` on the `jsname="Yust4d"` element), or
 * `null`. Its absence means there is at most one page, or this is not a
 * results page at all.
 */
export function extractGoogleCursor(html: string): string | null {
  if (!html || !html.includes('Yust4d')) return null;
  const $ = cheerio.load(html);
  const value = $('[jsname="Yust4d"][data-async-fc]').first().attr('data-async-fc');
  return value && value.trim() ? value.trim() : null;
}

/** Longest `<meta …>` tag inspected for a refresh to the JS-required page. */
const MAX_META_TAG_CHARS = 2048;

function hasEnableJsRefresh(lower: string): boolean {
  let from = 0;
  for (;;) {
    const at = lower.indexOf('<meta', from);
    if (at < 0) return false;
    const window = lower.slice(at, at + MAX_META_TAG_CHARS);
    const close = window.indexOf('>');
    const tag = close < 0 ? window : window.slice(0, close + 1);
    if (/http-equiv\s*=\s*["']?refresh/.test(tag) && tag.includes('enablejs')) return true;
    from = at + 5;
  }
}

/**
 * Google's own interstitials: the `/sorry/` rate-limit page, the "unusual
 * traffic" notice, and the JS-required redirect. A page that matches is a
 * block, not an empty result.
 */
export function looksLikeGoogleInterstitial(html: string, finalUrl?: string | null, status?: number | null): boolean {
  if (status === 429) return true;
  if (finalUrl && /\/sorry\//i.test(finalUrl)) return true;
  if (!html) return false;
  const lower = html.toLowerCase();
  if (lower.includes('unusual traffic')) return true;
  if (lower.includes('/httpservice/retry/enablejs')) return true;
  if (lower.includes('/sorry/index')) return true;
  return hasEnableJsRefresh(lower);
}

/** 32-bit string hash; the id fallback when a record carries no stable id. */
export function googleHashCode(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0;
  }
  return hash;
}

/** The row id: `go-<stable id>`, or `go-<url hash>` when the record has none. */
export function googleJobId(record: unknown[], jobUrl: string): string {
  const stable = record[GOOGLE_RECORD_INDEX.stableId];
  return nonBlankString(stable) ? `go-${stable.trim()}` : `go-${Math.abs(googleHashCode(jobUrl))}`;
}

interface GoogleLocation {
  location: LocationDto;
  locations: LocationDto[];
  isRemote: boolean;
  workFromHomeType: string | null;
}

/**
 * Location fields from the record's own label. "Anywhere" and friends are
 * remote with no site; they never become a city.
 */
export function googleLocation(label: string): GoogleLocation {
  const trimmed = label.trim();
  if (REMOTE_ONLY_LABEL_RE.test(trimmed)) {
    return { location: new LocationDto(), locations: [], isRemote: true, workFromHomeType: 'Remote' };
  }
  const parsed = parseLocationList([trimmed]);
  const isRemote = parsed.remoteMentioned || REMOTE_MENTION_RE.test(trimmed);
  return {
    location: parsed.location ?? new LocationDto(),
    locations: parsed.locations,
    isRemote,
    workFromHomeType: parsed.workFromHomeType ?? (isRemote ? 'Remote' : null),
  };
}

/** One row from one record, or `null` when the record is not job-shaped. */
export function googleRecordToJobPost(record: unknown): JobPostDto | null {
  if (!isJobRecord(record)) return null;
  const jobUrl = primaryLink(record);
  if (!jobUrl) return null;
  const title = (record[GOOGLE_RECORD_INDEX.title] as string).trim();
  const companyName = (record[GOOGLE_RECORD_INDEX.company] as string).trim();
  const where = googleLocation(record[GOOGLE_RECORD_INDEX.location] as string);

  return new JobPostDto({
    id: googleJobId(record, jobUrl),
    title,
    companyName,
    jobUrl,
    location: where.location,
    ...(where.locations.length > 0 ? { locations: where.locations } : {}),
    ...(where.isRemote ? { isRemote: true } : {}),
    ...(where.workFromHomeType ? { workFromHomeType: where.workFromHomeType } : {}),
    site: Site.GOOGLE,
  });
}

export interface GoogleParsedPage {
  jobs: JobPostDto[];
  /** Keys the records came from. */
  keys: string[];
  /** See {@link GoogleRecordScan.viaFallback}. */
  viaFallback: boolean;
}

/** Rows from one page, unique by id, in page order. */
export function parseGoogleJobRecords(text: string, options?: GoogleScanOptions): GoogleParsedPage {
  const scan = findJobRecords(text, options);
  const jobs: JobPostDto[] = [];
  const seen = new Set<string>();
  for (const record of scan.records) {
    const job = googleRecordToJobPost(record);
    if (!job || !job.id || seen.has(job.id)) continue;
    seen.add(job.id);
    jobs.push(job);
  }
  return { jobs, keys: scan.keys, viaFallback: scan.viaFallback };
}
