import type { RawCaptureSink, RawHttpEntry } from '@ever-jobs/models';

/**
 * Spec 5161 — shared plumbing for raw HTTP capture.
 *
 * Both instrumented transports (`http-client.ts` for axios calls and
 * `browser-pool.ts` for Playwright pages) write `RawHttpEntry`s into a
 * per-source `RawCaptureSink` carried by the request async context.
 */

const DEFAULT_MAX_BODY_BYTES = 5_242_880; // 5 MiB
const DEFAULT_MAX_SOURCE_BYTES = 20_971_520; // 20 MiB
const DEFAULT_DRAIN_MS = 2_000;

function envCap(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function rawCaptureMaxBodyBytes(): number {
  return envCap('RAW_CAPTURE_MAX_BODY_BYTES', DEFAULT_MAX_BODY_BYTES);
}

export function rawCaptureMaxSourceBytes(): number {
  return envCap('RAW_CAPTURE_MAX_SOURCE_BYTES', DEFAULT_MAX_SOURCE_BYTES);
}

export function createRawCaptureSink(): RawCaptureSink {
  return { entries: [], retained_bytes: 0, pending: [], closed: false };
}

/**
 * Query-string keys whose values must never reach a log line or a capture
 * entry. Several sources authenticate by query parameter (`source-ats-ceipal`
 * `api_key`, `source-ats-jazzhr` `apikey`, `source-ats-teamtailor` /
 * `source-ats-talentera` / `source-ats-comeet` `token`).
 */
export const SENSITIVE_QUERY_KEYS =
  /^(?:api[-_]?key|access[-_]?token|token|secret|password|passwd|pwd|auth|authorization|signature|sig|session|credentials?)$/i;

/**
 * Hosts that carry a credential in the URL *path* rather than the query string,
 * mapped to the zero-based index of the offending path segment. Ceipal routes
 * every tenant call through `https://api.ceipal.com/{apiKey}/job-postings/`; add
 * a row here if another one appears.
 */
export const SENSITIVE_PATH_SEGMENTS: Record<string, number> = {
  'api.ceipal.com': 0,
};

/** Scheme + authority of an absolute URL, e.g. `https://api.ceipal.com:443`. */
const URL_AUTHORITY = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i;

/**
 * Replace a credential carried as a path segment (see
 * `SENSITIVE_PATH_SEGMENTS`) with `REDACTED`. Relative URLs and hosts with no
 * rule are returned unchanged.
 */
export function redactPathCredential(url: string): string {
  const authority = URL_AUTHORITY.exec(url);
  if (!authority) return url;

  const host = authority[1].replace(/^.*@/, '').replace(/:\d+$/, '').toLowerCase();
  const index = SENSITIVE_PATH_SEGMENTS[host];
  if (index === undefined) return url;

  const pathStart = authority[0].length;
  const query = url.indexOf('?', pathStart);
  const fragment = url.indexOf('#', pathStart);
  const ends = [query, fragment].filter((i) => i !== -1);
  const pathEnd = ends.length ? Math.min(...ends) : url.length;

  // A path that starts with `/` splits to a leading empty segment, so the
  // first real segment is at index 1.
  const segments = url.slice(pathStart, pathEnd).split('/');
  const target = index + 1;
  if (target >= segments.length || !segments[target]) return url;

  segments[target] = 'REDACTED';
  return url.slice(0, pathStart) + segments.join('/') + url.slice(pathEnd);
}

/**
 * Replace the value of every credential-bearing query parameter with
 * `REDACTED`.
 */
export function redactQuery(url: string): string {
  const start = url.indexOf('?');
  if (start === -1) return url;

  const [query, ...fragment] = url.slice(start + 1).split('#');
  const redacted = query
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=');
      if (eq === -1) return pair;
      const key = pair.slice(0, eq);
      return SENSITIVE_QUERY_KEYS.test(key) ? `${key}=REDACTED` : pair;
    })
    .join('&');

  const hash = fragment.length ? `#${fragment.join('#')}` : '';
  return `${url.slice(0, start)}?${redacted}${hash}`;
}

/**
 * Strip credentials out of a URL before it reaches a log line or a capture
 * entry, leaving the rest intact so it still names its target. Splits on
 * delimiters rather than parsing, so a relative or malformed URL degrades to
 * "unchanged" instead of throwing inside a logging path.
 */
export function redactUrl(url: string): string {
  return redactQuery(redactPathCredential(url));
}

/** Redact any absolute URLs embedded in free text (error messages). */
export function sanitizeErrorText(text: string): string {
  return text.replace(/https?:\/\/\S+/g, (u) => redactUrl(u.replace(/[).,;]+$/, '')));
}

/** Recursively redact sensitive keys in a JSON-parsed value. */
export function redactSensitiveKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSensitiveKeys);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_QUERY_KEYS.test(key) ? 'REDACTED' : redactSensitiveKeys(v);
    }
    return out;
  }
  return value;
}

/**
 * `data` as a redacted JSON value, or `undefined` when it is not JSON.
 * Axios/body payloads that are strings are kept only when they parse.
 */
export function captureRequestBody(data: unknown): unknown {
  if (data === null || data === undefined) return undefined;
  if (typeof data === 'string') {
    try {
      return redactSensitiveKeys(JSON.parse(data));
    } catch {
      return undefined;
    }
  }
  if (typeof data === 'object') return redactSensitiveKeys(data);
  return undefined;
}

/**
 * Normalize a response payload to a retainable form. Returns the serialized
 * value plus its UTF-8 byte length, or `null` when the payload is a binary /
 * stream type we deliberately do not capture.
 */
export function normalizeBody(
  data: unknown,
  contentType?: string,
): { value: unknown; bytes: number } | null {
  if (data === null || data === undefined) return null;
  if (typeof data === 'string') {
    return { value: data, bytes: Buffer.byteLength(data, 'utf8') };
  }
  if (Buffer.isBuffer(data) || data instanceof Uint8Array) {
    const text = (data as Buffer).toString('utf8');
    return { value: text, bytes: (data as Buffer).byteLength };
  }
  if (typeof data === 'object') {
    // Streams (axios `responseType: 'stream'`) expose `pipe` — never read.
    if (typeof (data as { pipe?: unknown }).pipe === 'function') return null;
    let serialized: string;
    try {
      serialized = JSON.stringify(data);
    } catch {
      return null;
    }
    if (serialized === undefined) return null;
    return { value: data, bytes: Buffer.byteLength(serialized, 'utf8') };
  }
  if (typeof data === 'number' || typeof data === 'boolean') {
    const serialized = String(data);
    return { value: serialized, bytes: Buffer.byteLength(serialized, 'utf8') };
  }
  return null;
}

/** Truncate `text` to at most `maxBytes` UTF-8 bytes without splitting a character. */
export function truncateUtf8(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.byteLength <= maxBytes) return text;
  let truncated = buf.subarray(0, maxBytes).toString('utf8');
  // A split multi-byte character decodes as U+FFFD — drop the partial tail.
  while (truncated.endsWith('\uFFFD')) truncated = truncated.slice(0, -1);
  return truncated;
}

/**
 * Push an entry skeleton onto the sink, or return `null` when the sink is
 * closed — the response already shipped, so late writes are dropped rather
 * than buffered for nobody.
 */
export function pushRawEntry(
  sink: RawCaptureSink,
  fields: Omit<RawHttpEntry, 'seq'>,
): RawHttpEntry | null {
  if (sink.closed) return null;
  const entry: RawHttpEntry = { seq: sink.entries.length, ...fields };
  sink.entries.push(entry);
  return entry;
}

/**
 * Retain `body` on `entry` under both budgets: the per-body cap truncates the
 * value, the per-source cap decides whether anything is retained at all.
 * `body_bytes` always records the original serialized size.
 */
export function retainBody(
  sink: RawCaptureSink,
  entry: RawHttpEntry,
  normalized: { value: unknown; bytes: number } | null,
): void {
  if (!normalized) return;
  entry.body_bytes = normalized.bytes;

  let value = normalized.value;
  let bytes = normalized.bytes;
  const maxBody = rawCaptureMaxBodyBytes();
  if (bytes > maxBody) {
    entry.truncated = true;
    if (typeof value === 'string') {
      const shortened = truncateUtf8(value, maxBody);
      value = shortened;
      bytes = Buffer.byteLength(shortened, 'utf8');
    } else {
      // A JSON body cannot be partially parsed — omit it entirely.
      value = undefined;
      bytes = 0;
    }
  }

  if (sink.retained_bytes + bytes > rawCaptureMaxSourceBytes()) {
    entry.truncated = true;
    return;
  }
  if (value !== undefined) {
    entry.body = value;
    sink.retained_bytes += bytes;
  }
}

/**
 * Wait for in-flight body reads (browser responses finish asynchronously),
 * then close the sink so no further writes are accepted. The cap keeps a
 * wedged body read from delaying the response.
 */
export async function drainRawCapture(
  sink: RawCaptureSink,
  capMs: number = DEFAULT_DRAIN_MS,
): Promise<void> {
  if (sink.pending.length > 0) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.allSettled([...sink.pending]),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, capMs);
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
  }
  sink.closed = true;
}
