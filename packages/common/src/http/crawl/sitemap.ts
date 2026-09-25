import { gunzipSync } from 'zlib';
import { getDomain } from 'tldts';

import { SitemapEntry } from './types';

/** Minimal HTTP surface needed (an `HttpClient` satisfies it). */
export interface SitemapHttp {
  get<T = any>(url: string, config?: any): Promise<{ data: T; status?: number; headers?: any }>;
}

/** Default cap on `<url>` entries returned by `fetchSitemap` (the protocol's per-file limit). */
export const SITEMAP_DEFAULT_MAX_URLS = 50000;

/** Default number of `<sitemapindex>` hops `fetchSitemap` follows below the root document. */
export const SITEMAP_DEFAULT_MAX_DEPTH = 2;

/** Default cap on documents (root + nested) `fetchSitemap` fetches. */
export const SITEMAP_DEFAULT_MAX_SITEMAPS = 20;

/** Default cap on one (decompressed) sitemap body, in bytes. */
export const SITEMAP_DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Element nesting `parseSitemapXml` tracks; deeper elements are skipped whole.
 * Real sitemaps nest 3-4 levels (`urlset > url > image:image > image:loc`).
 */
export const SITEMAP_MAX_ELEMENT_DEPTH = 32;

/**
 * Which nested sitemaps (`<sitemapindex>` entries) `fetchSitemap` follows:
 * - `same-host`: only on the root sitemap's host;
 * - `same-domain` (default): on its registrable domain (`www.x.com` → `cdn.x.com`
 *   yes, `other.com` no) — the sitemaps protocol allows an index to list only
 *   sitemaps of its own site;
 * - `any`: every absolute http(s) URL (the pre-hardening behaviour).
 */
export type NestedSitemapScope = 'same-host' | 'same-domain' | 'any';

/** `Accept` header sent with every sitemap GET (XML first, plain-text sitemaps accepted). */
export const SITEMAP_ACCEPT_HEADER =
  'application/xml,text/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5';

/** Options for `fetchSitemap`. Every field is optional. */
export interface FetchSitemapOptions {
  /** Stop collecting after this many `<url>` entries (default 50,000). */
  maxUrls?: number;
  /** `<sitemapindex>` hops followed below the root document (default 2; 0 = root only). */
  maxDepth?: number;
  /** Documents fetched in total, root included (default 20). */
  maxSitemaps?: number;
  /** Keep only entries whose (absolute) `loc` passes; applied before `maxUrls` counts. */
  filter?: (loc: string) => boolean;
  /** Newest `lastmod` first; entries without a valid `lastmod` last; otherwise stable. */
  sortByLastmod?: boolean;
  /** Largest body accepted per document, after gunzip (default 10 MB). */
  maxBytes?: number;
  /**
   * Called when a *nested* sitemap cannot be fetched or decoded; it is skipped and the
   * walk continues. Errors on the root document are thrown to the caller instead.
   */
  onError?: (url: string, error: unknown) => void;
  /** Extra request config merged into every GET (e.g. `headers`, `timeout`). */
  requestConfig?: Record<string, any>;
  /** Nested sitemaps followed (default `same-domain`; see `NestedSitemapScope`). */
  nestedScope?: NestedSitemapScope;
}

interface OpenEntry {
  kind: 'url' | 'sitemap';
  prefix: string;
  depth: number;
  loc?: string;
  lastmod?: string;
}

interface OpenField {
  name: 'loc' | 'lastmod';
  depth: number;
  text: string;
}

/**
 * Parse a `<urlset>` or `<sitemapindex>` document (entities, CDATA, namespaces).
 *
 * A small, allocation-light scanner rather than a DOM: a 10 MB sitemap would cost
 * several times that in heap as a tree. It understands:
 *
 * - `<url>` children of `<urlset>` and `<sitemap>` children of `<sitemapindex>`,
 *   matched by *local* name, so a prefixed namespace (`<sm:urlset>`/`<sm:url>`) works;
 * - only the entry's *direct* `<loc>`/`<lastmod>` children with the entry's own
 *   prefix count, so `<image:loc>` (nested in `<image:image>`) is never mistaken for
 *   the page URL;
 * - CDATA sections, the five XML entities and numeric character references,
 *   comments, processing instructions and a DOCTYPE (with an internal subset);
 * - surrounding whitespace (trimmed).
 *
 * Anything else (HTML, JSON, truncated garbage) yields empty lists rather than
 * throwing. Relative `loc` values are returned as written (see `fetchSitemap`,
 * which resolves them against the sitemap URL).
 */
export function parseSitemapXml(xml: string): { urls: SitemapEntry[]; sitemaps: SitemapEntry[] } {
  const urls: SitemapEntry[] = [];
  const sitemaps: SitemapEntry[] = [];
  if (typeof xml !== 'string' || xml.length === 0) return { urls, sitemaps };

  const stack: string[] = [];
  let entry: OpenEntry | null = null;
  let field: OpenField | null = null;

  const closeField = () => {
    if (!field || !entry) {
      field = null;
      return;
    }
    const value = field.text.trim();
    if (value && entry[field.name] === undefined) entry[field.name] = value;
    field = null;
  };

  const closeEntry = () => {
    if (!entry) return;
    if (entry.loc) {
      const item = toEntry(entry.loc, entry.lastmod);
      (entry.kind === 'url' ? urls : sitemaps).push(item);
    }
    entry = null;
  };

  // Elements nested deeper than this are not tracked (sitemaps nest 3-4 levels):
  // a hostile document of endlessly nested tags plus stray close tags would
  // otherwise cost O(depth) per close tag, i.e. quadratic time on one thread.
  let overflow = 0;

  const len = xml.length;
  let i = 0;
  while (i < len) {
    const lt = xml.indexOf('<', i);
    const textEnd = lt === -1 ? len : lt;
    if (field && textEnd > i) (field as OpenField).text += decodeXmlEntities(xml.slice(i, textEnd));
    if (lt === -1) break;

    if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt + 9);
      const stop = end === -1 ? len : end;
      if (field) (field as OpenField).text += xml.slice(lt + 9, stop);
      i = end === -1 ? len : end + 3;
      continue;
    }
    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt + 4);
      i = end === -1 ? len : end + 3;
      continue;
    }
    if (xml.startsWith('<?', lt)) {
      const end = xml.indexOf('?>', lt + 2);
      i = end === -1 ? len : end + 2;
      continue;
    }
    if (xml.startsWith('<!', lt)) {
      // DOCTYPE (possibly with an internal subset `[ ... ]`) or another declaration.
      // The `[` is looked for only up to the `>`, so every declaration costs what
      // it spans (a document of `<!a>` repeated must not rescan the rest each time).
      const gt = xml.indexOf('>', lt + 2);
      if (gt === -1) break;
      const bracketAt = xml.slice(lt + 2, gt).indexOf('[');
      if (bracketAt !== -1) {
        const close = xml.indexOf(']', lt + 2 + bracketAt);
        const after = close === -1 ? -1 : xml.indexOf('>', close);
        i = after === -1 ? len : after + 1;
      } else {
        i = gt + 1;
      }
      continue;
    }

    const tagEnd = findTagEnd(xml, lt + 1);
    if (tagEnd === -1) break; // truncated tag — stop scanning
    const raw = xml.slice(lt + 1, tagEnd);
    i = tagEnd + 1;

    if (raw.startsWith('/')) {
      if (overflow > 0) {
        overflow--; // closes an untracked (too deep) element
        continue;
      }
      const name = raw.slice(1).trim();
      const at = stack.lastIndexOf(name);
      if (at === -1) continue; // stray close tag — ignore
      while (stack.length > at) {
        const depth = stack.length - 1;
        stack.pop();
        if (field && (field as OpenField).depth === depth) closeField();
        if (entry && (entry as OpenEntry).depth === depth) closeEntry();
      }
      continue;
    }

    const nameMatch = /^[^\s/>]+/.exec(raw);
    if (!nameMatch) continue;
    const name = nameMatch[0];
    const selfClosing = raw.endsWith('/');
    if (overflow > 0 || stack.length >= SITEMAP_MAX_ELEMENT_DEPTH) {
      if (!selfClosing) overflow++;
      continue;
    }
    const depth = stack.length;
    const local = localName(name);
    const prefix = prefixOf(name);
    const parentLocal = depth > 0 ? localName(stack[depth - 1]) : '';

    if (!entry) {
      if (local === 'url' && parentLocal === 'urlset') {
        entry = { kind: 'url', prefix, depth };
      } else if (local === 'sitemap' && parentLocal === 'sitemapindex') {
        entry = { kind: 'sitemap', prefix, depth };
      }
      if (entry && selfClosing) {
        entry = null;
        continue;
      }
    } else if (
      !field &&
      depth === (entry as OpenEntry).depth + 1 &&
      prefix === (entry as OpenEntry).prefix &&
      (local === 'loc' || local === 'lastmod')
    ) {
      if (selfClosing) continue;
      field = { name: local, depth, text: '' };
    }

    if (!selfClosing) stack.push(name);
  }

  // A truncated document: keep the entry in progress if its <loc> was complete.
  if (field) closeField();
  if (entry) closeEntry();

  return { urls, sitemaps };
}

/**
 * Parse a plain-text sitemap (one absolute `http(s)` URL per line, as the sitemaps
 * protocol allows). Other lines are ignored.
 */
export function parseSitemapText(text: string): SitemapEntry[] {
  if (typeof text !== 'string' || !text) return [];
  const out: SitemapEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    const loc = line.trim();
    if (/^https?:\/\/\S+$/i.test(loc)) out.push({ loc });
  }
  return out;
}

const W3C_DATETIME =
  /^(\d{4})(?:-(\d{2})(?:-(\d{2})(?:[Tt ]+(\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?\s*(Z|z|UTC|GMT|[+-]\d{2}(?::?\d{2})?)?)?)?)?$/;

/** RFC 1123 / 2822 style dates (`Thu, 24 Sep 2026 10:00:00 GMT`) seen in hand-rolled sitemaps. */
const RFC_DATETIME = /^(?:[A-Za-z]{3},?\s+)?\d{1,2}\s+[A-Za-z]{3}\s+\d{4}\s+\d{2}:\d{2}(?::\d{2})?\s*(?:GMT|UTC|Z|[+-]\d{4})$/;

/**
 * Accepts ISO 8601 / W3C Datetime (`YYYY`, `YYYY-MM`, `YYYY-MM-DD`,
 * `YYYY-MM-DDThh:mm[:ss[.s]][TZD]`), the space-separated `YYYY-MM-DD HH:MM:SS` form
 * Softy (and many CMSs) emit, and RFC 1123 dates. A value **without** a time zone is
 * read as UTC, so the result never depends on the server's local zone. Returns
 * undefined for anything invalid (including impossible dates such as `2026-02-30`).
 */
export function parseLastmod(raw: string | undefined): Date | undefined {
  if (typeof raw !== 'string') return undefined;
  const value = raw.trim();
  if (!value) return undefined;

  const m = W3C_DATETIME.exec(value);
  if (m) {
    const year = Number(m[1]);
    const month = m[2] !== undefined ? Number(m[2]) : 1;
    const day = m[3] !== undefined ? Number(m[3]) : 1;
    const hour = m[4] !== undefined ? Number(m[4]) : 0;
    const minute = m[5] !== undefined ? Number(m[5]) : 0;
    let second = m[6] !== undefined ? Number(m[6]) : 0;
    const millis = m[7] !== undefined ? Math.floor(Number(`0.${m[7]}`) * 1000) : 0;

    if (month < 1 || month > 12) return undefined;
    if (day < 1 || day > daysInMonth(year, month)) return undefined;
    if (minute > 59 || second > 60) return undefined;
    if (hour > 24 || (hour === 24 && (minute !== 0 || second !== 0 || millis !== 0))) return undefined;
    if (second === 60) second = 59; // leap second — clamp rather than roll the minute

    let time = Date.UTC(year, month - 1, day, hour, minute, second, millis);
    if (year < 100) {
      // Date.UTC maps 0..99 to 1900..1999; set the year explicitly.
      const d = new Date(time);
      d.setUTCFullYear(year);
      time = d.getTime();
    }

    const tz = m[8];
    if (tz && !/^(?:Z|UTC|GMT)$/i.test(tz)) {
      const sign = tz[0] === '-' ? -1 : 1;
      const digits = tz.slice(1).replace(':', '');
      const offH = Number(digits.slice(0, 2));
      const offM = digits.length > 2 ? Number(digits.slice(2, 4)) : 0;
      if (offH > 23 || offM > 59) return undefined;
      time -= sign * (offH * 60 + offM) * 60000;
    }
    return Number.isFinite(time) ? new Date(time) : undefined;
  }

  if (RFC_DATETIME.test(value)) {
    const time = Date.parse(value);
    return Number.isNaN(time) ? undefined : new Date(time);
  }
  return undefined;
}

/**
 * Newest `lastmod` first, entries without a valid `lastmod` last, ties in their
 * original order (a stable sort). Returns a new array.
 */
export function sortSitemapEntriesByLastmod(entries: SitemapEntry[]): SitemapEntry[] {
  return [...entries].sort((a, b) => {
    const ta = a.lastmod ? a.lastmod.getTime() : NaN;
    const tb = b.lastmod ? b.lastmod.getTime() : NaN;
    const aValid = !Number.isNaN(ta);
    const bValid = !Number.isNaN(tb);
    if (!aValid && !bValid) return 0;
    if (!aValid) return 1;
    if (!bValid) return -1;
    return tb - ta;
  });
}

/**
 * Turn a sitemap response body into text: strings pass through; `Buffer` /
 * `ArrayBuffer` / typed arrays are gunzipped when they start with the gzip magic
 * bytes (`1f 8b`) — whatever the URL or `Content-Type` says — and decoded as UTF-8
 * (UTF-16 when a BOM says so). Throws when the (decompressed) body exceeds `maxBytes`.
 */
export function decodeSitemapBody(data: unknown, maxBytes: number = SITEMAP_DEFAULT_MAX_BYTES): string {
  if (data == null) return '';
  if (typeof data === 'string') {
    if (data.charCodeAt(0) === 0x1f && data.charCodeAt(1) === 0x8b) {
      return decodeSitemapBody(Buffer.from(data, 'latin1'), maxBytes);
    }
    if (data.length > maxBytes) throw new Error(`Sitemap body exceeds ${maxBytes} bytes`);
    return stripBom(data);
  }

  let buf = toBuffer(data);
  if (!buf) return '';
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    try {
      buf = gunzipSync(buf, { maxOutputLength: maxBytes });
    } catch (err: any) {
      if (err?.code === 'ERR_BUFFER_TOO_LARGE' || err instanceof RangeError) {
        throw new Error(`Sitemap body exceeds ${maxBytes} bytes after gunzip`);
      }
      throw new Error(`Sitemap body is not valid gzip: ${err?.message ?? err}`);
    }
  }
  if (buf.length > maxBytes) throw new Error(`Sitemap body exceeds ${maxBytes} bytes`);

  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return stripBom(buf.toString('utf16le'));
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(buf);
    swapped.swap16();
    return stripBom(swapped.toString('utf16le'));
  }
  return stripBom(buf.toString('utf8'));
}

/**
 * Fetch a sitemap (following `<sitemapindex>` up to `maxDepth`, `.gz` supported)
 * and return its `<url>` entries, newest `lastmod` first when `sortByLastmod`.
 *
 * - Every GET goes through `http` (so the crawl policy's pacing, identity and
 *   back-off apply) with `responseType: 'arraybuffer'`, which lets gzip bodies be
 *   detected by their magic bytes whether the URL ends in `.gz` or not.
 * - Documents are walked breadth-first; each is fetched once (cycles are ignored);
 *   at most `maxSitemaps` are fetched in total. Nested sitemaps outside
 *   `nestedScope` (default: the root's registrable domain) are reported to
 *   `onError` and skipped.
 * - Relative `loc` values are resolved against the document's URL; duplicates are
 *   dropped (keeping the newest `lastmod`).
 * - A plain-text sitemap (one URL per line) is accepted too.
 * - An error on the root document (HTTP status, size cap, bad gzip) is thrown; errors
 *   on nested documents are reported to `onError` and skipped. Unparseable content is
 *   not an error: it contributes no entries.
 */
export async function fetchSitemap(
  http: SitemapHttp,
  url: string,
  options: FetchSitemapOptions = {},
): Promise<SitemapEntry[]> {
  const maxUrls = positiveInt(options.maxUrls, SITEMAP_DEFAULT_MAX_URLS);
  const maxDepth = nonNegativeInt(options.maxDepth, SITEMAP_DEFAULT_MAX_DEPTH);
  const maxSitemaps = positiveInt(options.maxSitemaps, SITEMAP_DEFAULT_MAX_SITEMAPS);
  const maxBytes = positiveInt(options.maxBytes, SITEMAP_DEFAULT_MAX_BYTES);
  const nestedScope: NestedSitemapScope =
    options.nestedScope === 'same-host' || options.nestedScope === 'any' ? options.nestedScope : 'same-domain';

  const out: SitemapEntry[] = [];
  const positions = new Map<string, number>();
  const visited = new Set<string>();
  const queue: Array<{ url: string; depth: number }> = [{ url, depth: 0 }];
  let fetched = 0;

  while (queue.length > 0 && fetched < maxSitemaps && out.length < maxUrls) {
    const next = queue.shift() as { url: string; depth: number };
    if (visited.has(next.url)) continue;
    visited.add(next.url);
    fetched++;

    let text: string;
    try {
      const response = await http.get(next.url, {
        ...(options.requestConfig ?? {}),
        responseType: 'arraybuffer',
        maxContentLength: maxBytes,
        headers: { Accept: SITEMAP_ACCEPT_HEADER, ...(options.requestConfig?.headers ?? {}) },
      });
      text = decodeSitemapBody(response?.data, maxBytes);
    } catch (err) {
      if (next.depth === 0) throw err;
      options.onError?.(next.url, err);
      continue;
    }

    const trimmed = text.trimStart();
    const doc = trimmed.startsWith('<')
      ? parseSitemapXml(text)
      : { urls: parseSitemapText(text), sitemaps: [] as SitemapEntry[] };

    for (const item of doc.urls) {
      if (out.length >= maxUrls) break;
      const loc = resolveUrl(item.loc, next.url);
      if (!loc) continue;
      if (options.filter && !options.filter(loc)) continue;
      const seen = positions.get(loc);
      if (seen !== undefined) {
        const prev = out[seen];
        if (item.lastmod && (!prev.lastmod || item.lastmod.getTime() > prev.lastmod.getTime())) {
          out[seen] = { ...item, loc };
        }
        continue;
      }
      positions.set(loc, out.length);
      out.push(loc === item.loc ? item : { ...item, loc });
    }

    if (next.depth < maxDepth) {
      for (const child of doc.sitemaps) {
        const childUrl = resolveUrl(child.loc, next.url);
        if (!childUrl || visited.has(childUrl)) continue;
        if (!nestedSitemapAllowed(childUrl, url, nestedScope)) {
          options.onError?.(childUrl, new Error(`nested sitemap outside the root's ${nestedScope} scope; skipped`));
          continue;
        }
        queue.push({ url: childUrl, depth: next.depth + 1 });
      }
    }
  }

  return options.sortByLastmod ? sortSitemapEntriesByLastmod(out) : out;
}

// ── helpers ────────────────────────────────────────────────────────────────

function toEntry(loc: string, lastmodRaw: string | undefined): SitemapEntry {
  const entry: SitemapEntry = { loc };
  if (lastmodRaw !== undefined) {
    entry.lastmodRaw = lastmodRaw;
    const lastmod = parseLastmod(lastmodRaw);
    if (lastmod) entry.lastmod = lastmod;
  }
  return entry;
}

/** Index of the `>` closing a tag that starts at `from`, skipping quoted attribute values. */
function findTagEnd(xml: string, from: number): number {
  let quote = '';
  for (let j = from; j < xml.length; j++) {
    const c = xml[j];
    if (quote) {
      if (c === quote) quote = '';
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '>') {
      return j;
    }
  }
  return -1;
}

function localName(name: string): string {
  const colon = name.indexOf(':');
  return (colon === -1 ? name : name.slice(colon + 1)).toLowerCase();
}

function prefixOf(name: string): string {
  const colon = name.indexOf(':');
  return colon === -1 ? '' : name.slice(0, colon);
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/** Decode the five XML entities and numeric references; unknown entities are kept verbatim. */
function decodeXmlEntities(text: string): string {
  if (text.indexOf('&') === -1) return text;
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[A-Za-z]+);/g, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    const named = NAMED_ENTITIES[body];
    return named !== undefined ? named : whole;
  });
}

function daysInMonth(year: number, month: number): number {
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function toBuffer(data: unknown): Buffer | null {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

/** An absolute `loc` is returned as written (trimmed); a relative one is resolved against `base`. */
function resolveUrl(loc: string, base: string): string | null {
  const value = loc.trim();
  if (!value) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return value;
  try {
    return new URL(value, base).toString();
  } catch {
    return null;
  }
}

/** Whether a nested sitemap at `childUrl` may be followed from a walk rooted at `rootUrl`. */
function nestedSitemapAllowed(childUrl: string, rootUrl: string, scope: NestedSitemapScope): boolean {
  let child: URL;
  let root: URL;
  try {
    child = new URL(childUrl);
    root = new URL(rootUrl);
  } catch {
    return false;
  }
  if (child.protocol !== 'http:' && child.protocol !== 'https:') return false;
  if (scope === 'any') return true;
  const childHost = child.hostname.toLowerCase().replace(/\.+$/, '');
  const rootHost = root.hostname.toLowerCase().replace(/\.+$/, '');
  if (childHost === rootHost) return true;
  if (scope === 'same-host') return false;
  const childDomain = registrableDomain(childHost);
  return childDomain !== null && childDomain === registrableDomain(rootHost);
}

function registrableDomain(host: string): string | null {
  try {
    return getDomain(host) || null;
  } catch {
    return null;
  }
}

function positiveInt(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function nonNegativeInt(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}
