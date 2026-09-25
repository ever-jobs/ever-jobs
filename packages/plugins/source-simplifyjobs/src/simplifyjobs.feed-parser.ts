import { createHash } from 'crypto';
import {
  SIMPLIFYJOBS_COMPANY_URL_PREFIX,
  SIMPLIFYJOBS_MAX_BODY_BYTES,
  SIMPLIFYJOBS_MAX_LOCATIONS_PER_ROW,
  SIMPLIFYJOBS_MAX_ROW_BYTES,
} from './simplifyjobs.constants';
import { normalizeCategory, normalizeSponsorship } from './simplifyjobs.mapper';
import { compareRows } from './simplifyjobs.query';
import { SimplifyFeedKind, SimplifyRawRow, SimplifyRow } from './simplifyjobs.types';

/**
 * Feed body parsing that never holds the whole body as a string or as a parse
 * tree (Spec 1694, heap budget).
 *
 * A feed is ~13 MB of JSON: one array of ~20k flat objects, most of them
 * inactive. `JSON.parse` of the whole text would put a 13–27 MB string and
 * ~20k full objects on the heap at once. Instead the bytes are scanned for the
 * array's top-level elements; each element's own text (under 2 KB) is decoded
 * and parsed alone, compacted to a {@link SimplifyRow} or dropped, and released
 * before the next. Peak heap is one row plus the compacted result; the body
 * itself stays an off-heap `Buffer`.
 */

/** The body is not the JSON array we expect. Classified as `fetch_error`. */
export class SimplifyFeedFormatError extends Error {
  constructor(detail: string) {
    super(`simplifyjobs: invalid feed JSON: ${detail}`);
    this.name = 'SimplifyFeedFormatError';
  }
}

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const OPEN_BRACE = 0x7b;
const CLOSE_BRACE = 0x7d;
const OPEN_BRACKET = 0x5b;
const CLOSE_BRACKET = 0x5d;
const COMMA = 0x2c;

function isJsonWhitespace(byte: number): boolean {
  return byte === 0x20 || byte === 0x0a || byte === 0x0d || byte === 0x09;
}

/** UTF-8 byte order mark bytes, tolerated before the opening bracket. */
function isBomByte(byte: number): boolean {
  return byte === 0xef || byte === 0xbb || byte === 0xbf;
}

export interface FeedArrayScannerOptions {
  /** One element's text may not exceed this many bytes. */
  maxElementBytes?: number;
  /** The whole body may not exceed this many bytes. */
  maxTotalBytes?: number;
}

/**
 * Incremental splitter of a JSON array into its top-level object elements.
 * Feed it chunks with {@link push} (any size, split anywhere — mid-string,
 * mid-escape, mid-UTF-8 sequence), then call {@link end}. Each complete object
 * element's text is handed to `onObject`. Non-object elements are skipped and
 * counted.
 *
 * Structural bytes are all ASCII and UTF-8 continuation bytes never are, so
 * scanning bytes is exact. Syntax between elements (commas) is not validated;
 * each element is validated by `JSON.parse`. A body that is not an array, is
 * truncated, or has data after its closing bracket is rejected.
 */
export class FeedArrayScanner {
  private started = false;
  private ended = false;
  /** 0 outside the array, 1 inside it, 2+ inside an element. */
  private depth = 0;
  private inString = false;
  private escaped = false;
  private capturing = false;
  /** Inside a number / true / false / null element. */
  private inScalar = false;
  private carry: Buffer[] = [];
  private carryBytes = 0;
  private totalBytes = 0;
  private skippedCount = 0;
  private readonly maxElementBytes: number;
  private readonly maxTotalBytes: number;

  constructor(
    private readonly onObject: (json: string) => void,
    options: FeedArrayScannerOptions = {},
  ) {
    this.maxElementBytes = options.maxElementBytes ?? SIMPLIFYJOBS_MAX_ROW_BYTES;
    this.maxTotalBytes = options.maxTotalBytes ?? SIMPLIFYJOBS_MAX_BODY_BYTES;
  }

  /** Top-level elements that were not objects. */
  get skipped(): number {
    return this.skippedCount;
  }

  push(chunk: Uint8Array): void {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    this.totalBytes += buf.length;
    if (this.totalBytes > this.maxTotalBytes) {
      throw new SimplifyFeedFormatError(`body exceeds ${this.maxTotalBytes} bytes`);
    }

    let start = this.capturing ? 0 : -1;
    for (let i = 0; i < buf.length; i++) {
      const byte = buf[i];

      if (this.inString) {
        if (this.escaped) this.escaped = false;
        else if (byte === BACKSLASH) this.escaped = true;
        else if (byte === QUOTE) this.inString = false;
        continue;
      }
      if (isJsonWhitespace(byte)) {
        this.inScalar = false;
        continue;
      }

      if (!this.started) {
        if (isBomByte(byte) && this.totalBytes - buf.length + i < 3) continue;
        if (byte !== OPEN_BRACKET) throw new SimplifyFeedFormatError('the body is not a JSON array');
        this.started = true;
        this.depth = 1;
        continue;
      }
      if (this.ended) throw new SimplifyFeedFormatError('data after the closing bracket');

      if (byte === COMMA || byte === CLOSE_BRACKET || byte === CLOSE_BRACE) this.inScalar = false;
      switch (byte) {
        case QUOTE:
          this.inString = true;
          if (this.depth === 1) this.skippedCount++;
          break;
        case OPEN_BRACE:
        case OPEN_BRACKET:
          if (this.depth === 1) {
            if (byte === OPEN_BRACE) {
              this.capturing = true;
              start = i;
            } else {
              this.skippedCount++;
            }
          }
          this.depth++;
          break;
        case CLOSE_BRACE:
        case CLOSE_BRACKET:
          this.depth--;
          if (this.depth === 1 && this.capturing) {
            this.emit(buf, start, i + 1);
            start = -1;
          } else if (this.depth === 0) {
            if (byte !== CLOSE_BRACKET) throw new SimplifyFeedFormatError('unbalanced brackets');
            this.ended = true;
          } else if (this.depth < 0) {
            throw new SimplifyFeedFormatError('unbalanced brackets');
          }
          break;
        case COMMA:
          break;
        default:
          // A number / true / false / null element, counted once.
          if (this.depth === 1 && !this.inScalar) {
            this.inScalar = true;
            this.skippedCount++;
          }
      }
    }

    if (this.capturing && start !== -1) {
      const tail = Buffer.from(buf.subarray(start));
      this.carry.push(tail);
      this.carryBytes += tail.length;
      if (this.carryBytes > this.maxElementBytes) {
        throw new SimplifyFeedFormatError(`an element exceeds ${this.maxElementBytes} bytes`);
      }
    }
  }

  end(): void {
    if (!this.started) throw new SimplifyFeedFormatError('the body is empty');
    if (!this.ended) throw new SimplifyFeedFormatError('the body ends before its closing bracket');
  }

  private emit(buf: Buffer, start: number, end: number): void {
    const size = this.carryBytes + (end - start);
    if (size > this.maxElementBytes) {
      throw new SimplifyFeedFormatError(`an element exceeds ${this.maxElementBytes} bytes`);
    }
    const text =
      this.carry.length > 0
        ? Buffer.concat([...this.carry, buf.subarray(start, end)], size).toString('utf8')
        : buf.toString('utf8', start, end);
    this.carry = [];
    this.carryBytes = 0;
    this.capturing = false;
    this.onObject(text);
  }
}

/** Shares repeated strings and string lists across the rows of one feed. */
export class StringInterner {
  private readonly strings = new Map<string, string>();
  private readonly lists = new Map<string, readonly string[]>();

  string(value: string): string {
    const hit = this.strings.get(value);
    if (hit !== undefined) return hit;
    this.strings.set(value, value);
    return value;
  }

  list(values: string[]): readonly string[] {
    if (values.length === 0) return EMPTY_LIST;
    const key = values.join('\u0000');
    const hit = this.lists.get(key);
    if (hit) return hit;
    const list = Object.freeze(values.map((v) => this.string(v)));
    this.lists.set(key, list);
    return list;
  }
}

const EMPTY_LIST: readonly string[] = Object.freeze([]);
const MAX_TEXT_LENGTH = 500;

function cleanText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length > MAX_TEXT_LENGTH ? text.slice(0, MAX_TEXT_LENGTH).trim() : text;
}

/** An absolute http(s) URL, trimmed; anything else (relative, `javascript:`, junk) → null. */
function cleanUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const url = value.trim();
  if (!/^https?:\/\/[^\s/?#]+/i.test(url) || url.length > 2048) return null;
  try {
    new URL(url);
  } catch {
    return null;
  }
  return url;
}

/** Epoch seconds from a positive finite number; a millisecond value is converted. */
function epochSeconds(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return value >= 1e11 ? Math.floor(value / 1000) : Math.floor(value);
}

function stringList(value: unknown, max: number, keep: (s: string) => boolean): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const text = cleanText(item);
    if (text && keep(text)) out.push(text);
    if (out.length >= max) break;
  }
  return out;
}

const ROW_ID_RE = /^[\w-]{1,64}$/;

/** The row's own id, or a stable UUID-shaped id derived from its apply URL. */
function rowId(value: unknown, url: string): string {
  if (typeof value === 'string' && ROW_ID_RE.test(value.trim())) return value.trim();
  const hex = createHash('sha1').update(url).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Compact one parsed element, or drop it. Kept only when `active === true`,
 * `is_visible !== false` (missing means visible), and it has a title, a
 * company and an absolute http(s) apply URL. The `source` field (who added
 * the row) and the degree list are never kept.
 */
export function compactRow(raw: unknown, feed: SimplifyFeedKind, intern: StringInterner): SimplifyRow | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as SimplifyRawRow;
  if (r.active !== true || r.is_visible === false) return null;
  const url = cleanUrl(r.url);
  const title = cleanText(r.title);
  const companyName = cleanText(r.company_name);
  if (!url || !title || !companyName) return null;

  const companyUrl = cleanUrl(r.company_url);
  const category = normalizeCategory(r.category);
  return {
    id: rowId(r.id, url),
    feed,
    title,
    companyName: intern.string(companyName),
    companyUrl: companyUrl && companyUrl.startsWith(SIMPLIFYJOBS_COMPANY_URL_PREFIX) ? intern.string(companyUrl) : null,
    category: category === null ? null : intern.string(category),
    terms: intern.list(stringList(r.terms, 10, (t) => t.toLowerCase() !== 'n/a')),
    datePosted: epochSeconds(r.date_posted),
    dateUpdated: epochSeconds(r.date_updated),
    url,
    locations: intern.list(stringList(r.locations, SIMPLIFYJOBS_MAX_LOCATIONS_PER_ROW, () => true)),
    sponsorship: normalizeSponsorship(r.sponsorship),
  };
}

export interface ParsedFeed {
  /** Live rows, newest first. */
  rows: SimplifyRow[];
  /** Top-level object elements seen. */
  total: number;
  /** Top-level elements that were not objects. */
  skipped: number;
  /** Newest `date_posted` among kept rows (epoch seconds), or null. */
  newestPosted: number | null;
}

function toBuffer(body: unknown): Buffer {
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  throw new SimplifyFeedFormatError(`unexpected body type ${body === null ? 'null' : typeof body}`);
}

/**
 * Parse a whole feed body (`Buffer`, `ArrayBuffer`, typed array or string)
 * into live, compacted rows sorted newest first. Throws
 * {@link SimplifyFeedFormatError} when the body is not a JSON array of objects.
 */
export function parseFeedBody(body: unknown, feed: SimplifyFeedKind, options: FeedArrayScannerOptions = {}): ParsedFeed {
  const intern = new StringInterner();
  const rows: SimplifyRow[] = [];
  let total = 0;
  let newestPosted: number | null = null;
  const scanner = new FeedArrayScanner((json) => {
    total++;
    let raw: unknown;
    try {
      raw = JSON.parse(json);
    } catch {
      throw new SimplifyFeedFormatError(`element ${total} is not valid JSON`);
    }
    const row = compactRow(raw, feed, intern);
    if (!row) return;
    rows.push(row);
    if (row.datePosted !== null && (newestPosted === null || row.datePosted > newestPosted)) {
      newestPosted = row.datePosted;
    }
  }, options);
  scanner.push(toBuffer(body));
  scanner.end();
  rows.sort(compareRows);
  return { rows, total, skipped: scanner.skipped, newestPosted };
}
