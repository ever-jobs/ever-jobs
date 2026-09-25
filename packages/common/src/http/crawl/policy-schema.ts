import { domainToASCII } from 'node:url';

import { EVER_JOBS_DEFAULT_USER_AGENT, USER_AGENT_KEYWORDS } from './defaults';
import {
  CallerOverridePolicy,
  CrawlPolicy,
  CrawlPolicyOverride,
  CrawlPreset,
  DiscoveryMode,
  ProxyRotation,
  RateLimitScope,
  RetryAfterOverMax,
  RetryBackoff,
  RobotsTxtMode,
  UserAgentMode,
} from './types';

/**
 * Field schema and value coercion shared by the crawl-policy env reader
 * (`env.ts`) and resolver (`resolve.ts`) — Spec 1690. Kept in its own module so
 * those two do not import each other. Not re-exported from the package index;
 * the public names are re-exported from `resolve.ts`.
 */

/**
 * Upper bound for every numeric knob. `setTimeout` treats anything above
 * 2^31-1 ms (~24.8 days) as 1 ms, so a larger interval would *remove* pacing.
 */
export const MAX_CRAWL_POLICY_INT = 2_147_483_647;

export const USER_AGENT_MODES: readonly UserAgentMode[] = ['identify', 'strict', 'plugin'];
export const PROXY_ROTATIONS: readonly ProxyRotation[] = ['per-request', 'per-scrape', 'per-host', 'off'];
export const RATE_LIMIT_SCOPES: readonly RateLimitScope[] = ['host', 'domain', 'site'];
export const ROBOTS_TXT_MODES: readonly RobotsTxtMode[] = ['off', 'crawl-delay', 'respect'];
export const RETRY_BACKOFFS: readonly RetryBackoff[] = ['exponential', 'linear', 'constant'];
export const RETRY_AFTER_OVER_MAX_MODES: readonly RetryAfterOverMax[] = ['give-up', 'cap'];
export const DISCOVERY_MODES: readonly DiscoveryMode[] = ['auto', 'sitemap', 'listing'];
export const CALLER_OVERRIDE_POLICIES: readonly CallerOverridePolicy[] = ['any', 'stricter', 'none'];
export const CRAWL_PRESET_NAMES: readonly CrawlPreset[] = ['polite', 'legacy', 'strict'];

export type CrawlPolicyFieldSpec =
  | { kind: 'string' }
  | { kind: 'enum'; values: readonly string[] }
  | { kind: 'bool' }
  | { kind: 'int' }
  | { kind: 'statuses' };

/** Every `CrawlPolicy` field and the kind of value it takes (the single source of truth). */
export const CRAWL_POLICY_FIELD_SPECS: { readonly [K in keyof CrawlPolicy]-?: CrawlPolicyFieldSpec } = {
  userAgent: { kind: 'string' },
  userAgentMode: { kind: 'enum', values: USER_AGENT_MODES },
  from: { kind: 'string' },
  stripClientHints: { kind: 'bool' },

  proxyRotation: { kind: 'enum', values: PROXY_ROTATIONS },

  rateLimitScope: { kind: 'enum', values: RATE_LIMIT_SCOPES },
  maxConcurrentPerHost: { kind: 'int' },
  minIntervalMs: { kind: 'int' },
  jitterMs: { kind: 'int' },
  maxQueueWaitMs: { kind: 'int' },
  adaptiveThrottle: { kind: 'bool' },

  retries: { kind: 'int' },
  retryStatuses: { kind: 'statuses' },
  retryBackoff: { kind: 'enum', values: RETRY_BACKOFFS },
  retryBaseDelayMs: { kind: 'int' },
  retryMaxDelayMs: { kind: 'int' },
  retryJitter: { kind: 'bool' },
  retryOnNetworkError: { kind: 'bool' },
  respectRetryAfter: { kind: 'bool' },
  maxRetryAfterMs: { kind: 'int' },
  retryAfterOverMax: { kind: 'enum', values: RETRY_AFTER_OVER_MAX_MODES },
  throttleRetryDelayMs: { kind: 'int' },

  robotsTxt: { kind: 'enum', values: ROBOTS_TXT_MODES },
  blockPrivateNetworks: { kind: 'bool' },
  discovery: { kind: 'enum', values: DISCOVERY_MODES },
};

/** Every `CrawlPolicy` field name, in declaration order. */
export const CRAWL_POLICY_FIELDS: readonly (keyof CrawlPolicy)[] = Object.keys(
  CRAWL_POLICY_FIELD_SPECS,
) as (keyof CrawlPolicy)[];

export function isCrawlPolicyField(key: string): key is keyof CrawlPolicy {
  return hasOwn(CRAWL_POLICY_FIELD_SPECS, key);
}

export function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/** Keys that would reach `Object.prototype` if assigned on a plain object. */
export function isUnsafeKey(key: string): boolean {
  return key === '__proto__' || key === 'constructor' || key === 'prototype';
}

/**
 * JSON has no comments, so operators annotate policy files with `"$comment"`,
 * `"_note"` or `"// why"` keys. Those are skipped without a warning.
 */
export function isCommentKey(key: string): boolean {
  return key.startsWith('$') || key.startsWith('_') || key.startsWith('//');
}

/** Short, single-line rendering of an untrusted value for a warning. */
export function describeValue(raw: unknown): string {
  let text: string;
  if (typeof raw === 'string') text = JSON.stringify(raw);
  else {
    try {
      text = JSON.stringify(raw) ?? String(raw);
    } catch {
      text = String(raw);
    }
  }
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

/** Result of coercing one untrusted value. `problem` = rejected; `note` = accepted with an adjustment. */
export interface CoerceResult<T = unknown> {
  value?: T;
  problem?: string;
  note?: string;
}

const HEADER_UNSAFE_CHARS = /[^\t\x20-\x7e\x80-\xff]/g;

/**
 * Strip what Node's HTTP layer refuses in a header value (CR/LF and other
 * control characters, code points above U+00FF), then trim.
 */
export function sanitizeHeaderValue(value: string): string {
  return value.replace(HEADER_UNSAFE_CHARS, '').trim();
}

const TRUE_WORDS = new Set(['true', '1', 'yes', 'on', 'y']);
const FALSE_WORDS = new Set(['false', '0', 'no', 'off', 'n']);

/** `true/false/1/0/yes/no/on/off` (case-insensitive), a boolean, or the numbers 0/1. */
export function coerceBoolean(raw: unknown): CoerceResult<boolean> {
  if (typeof raw === 'boolean') return { value: raw };
  if (raw === 0 || raw === 1) return { value: raw === 1 };
  if (typeof raw === 'string') {
    const word = raw.trim().toLowerCase();
    if (TRUE_WORDS.has(word)) return { value: true };
    if (FALSE_WORDS.has(word)) return { value: false };
  }
  return { problem: `invalid boolean ${describeValue(raw)} (expected true/false/1/0/yes/no/on/off)` };
}

/** A non-negative integer (number or numeric string). Fractions are floored, huge values clamped. */
export function coerceNonNegativeInt(raw: unknown): CoerceResult<number> {
  let n: number;
  if (typeof raw === 'number') n = raw;
  else if (typeof raw === 'string' && raw.trim() !== '') n = Number(raw.trim());
  else return { problem: `invalid number ${describeValue(raw)} (expected an integer >= 0)` };

  if (!Number.isFinite(n) || n < 0) {
    return { problem: `invalid number ${describeValue(raw)} (expected an integer >= 0)` };
  }
  if (n > MAX_CRAWL_POLICY_INT) {
    return { value: MAX_CRAWL_POLICY_INT, note: `${describeValue(raw)} clamped to ${MAX_CRAWL_POLICY_INT}` };
  }
  if (!Number.isInteger(n)) {
    return { value: Math.floor(n), note: `${describeValue(raw)} rounded down to ${Math.floor(n)}` };
  }
  return { value: n };
}

/** An enum value, case-insensitive, `_`/space accepted for `-` (`give_up` = `give-up`). */
export function coerceEnum<T extends string>(raw: unknown, values: readonly T[]): CoerceResult<T> {
  if (typeof raw === 'string') {
    const word = raw.trim().toLowerCase().replace(/[_\s]+/g, '-');
    const hit = values.find((v) => v === word);
    if (hit !== undefined) return { value: hit };
  }
  return { problem: `invalid value ${describeValue(raw)} (expected ${values.join(' | ')})` };
}

/** A header-safe, non-empty string (UA or `From`). */
export function coerceHeaderString(raw: unknown): CoerceResult<string> {
  if (typeof raw !== 'string') return { problem: `invalid value ${describeValue(raw)} (expected a string)` };
  const clean = sanitizeHeaderValue(raw);
  if (!clean) return { problem: `empty value ${describeValue(raw)}` };
  if (clean !== raw.trim()) return { value: clean, note: 'characters not allowed in an HTTP header were removed' };
  return { value: clean };
}

const NO_STATUSES = new Set(['none', 'off', '-']);

/**
 * HTTP statuses 100-599: an array of numbers/strings or a comma/space separated
 * string. `none`/`off`/`-` (or an empty array) = no status is retried. Invalid
 * entries are dropped with a note; if nothing valid remains the value is rejected.
 */
export function coerceStatusList(raw: unknown): CoerceResult<number[]> {
  let items: unknown[];
  if (Array.isArray(raw)) items = raw;
  else if (typeof raw === 'number') items = [raw];
  else if (typeof raw === 'string') {
    const trimmed = raw.trim().toLowerCase();
    if (NO_STATUSES.has(trimmed)) return { value: [] };
    items = trimmed.split(/[\s,;]+/).filter((s) => s.length > 0);
  } else {
    return { problem: `invalid status list ${describeValue(raw)} (expected e.g. "429,503")` };
  }
  if (items.length === 0) return { value: [] };

  const out: number[] = [];
  const bad: unknown[] = [];
  for (const item of items) {
    const n = typeof item === 'number' ? item : typeof item === 'string' ? Number(item.trim()) : NaN;
    if (Number.isInteger(n) && n >= 100 && n <= 599) {
      if (!out.includes(n)) out.push(n);
    } else {
      bad.push(item);
    }
  }
  if (out.length === 0) {
    return { problem: `invalid status list ${describeValue(raw)} (expected HTTP statuses 100-599)` };
  }
  if (bad.length > 0) {
    return { value: out, note: `ignored invalid statuses ${describeValue(bad)} (expected 100-599)` };
  }
  return { value: out };
}

/** Coerce one untrusted value for `field`. */
export function coerceCrawlField(field: keyof CrawlPolicy, raw: unknown): CoerceResult {
  const spec = CRAWL_POLICY_FIELD_SPECS[field];
  switch (spec.kind) {
    case 'string':
      return coerceHeaderString(raw);
    case 'enum':
      return coerceEnum(raw, spec.values);
    case 'bool':
      return coerceBoolean(raw);
    case 'int':
      return coerceNonNegativeInt(raw);
    case 'statuses':
      return coerceStatusList(raw);
  }
}

/** See `normalizeCrawlOverride` in `resolve.ts` (public name). */
export function normalizeOverride(raw: unknown): { value: CrawlPolicyOverride; warnings: string[] } {
  const value: CrawlPolicyOverride = {};
  const warnings: string[] = [];
  if (raw === undefined || raw === null) return { value, warnings };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    warnings.push(`expected an object of crawl-policy fields, got ${describeValue(raw)}`);
    return { value, warnings };
  }

  const record = value as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    const item = (raw as Record<string, unknown>)[key];
    // `undefined`/`null` mean "not set at this layer" — e.g. an optional DTO field.
    if (item === undefined || item === null) continue;
    if (!isCrawlPolicyField(key)) {
      // `userAgentReason` is plugin metadata, not a policy field. The key is
      // untrusted (an API body): quoted and cut to 80 characters in the warning.
      if (key !== 'userAgentReason' && !isCommentKey(key)) {
        warnings.push(`${describeValue(key)}: unknown crawl-policy field; ignored`);
      }
      continue;
    }
    const result = coerceCrawlField(key, item);
    if (result.problem !== undefined) {
      warnings.push(`${key}: ${result.problem}; ignored`);
      continue;
    }
    if (result.note !== undefined) warnings.push(`${key}: ${result.note}`);
    record[key] = result.value;
  }
  return { value, warnings };
}

// ── Hosts ────────────────────────────────────────────────────────────────────

/** `scheme://authority` — the authority ends at the first `/`, `?`, `#` or `\`. */
const URL_AUTHORITY = /^[a-z][a-z0-9+.-]*:\/\/([^/?#\\]*)/;

/**
 * Normalise a hostname: trim, lower-case, drop a trailing dot and a `:port`;
 * a full URL is reduced to its hostname; an internationalised name becomes its
 * punycode (ASCII) form, as it appears on the wire. `undefined` when nothing is
 * left.
 */
export function normalizeHostName(value: string | undefined | null): string | undefined {
  if (typeof value !== 'string') return undefined;
  let host = value.trim().toLowerCase();
  if (!host) return undefined;
  if (host.includes('://')) {
    // Hot path (called per request with a full URL): take the authority with a
    // regex instead of `new URL()` (~10x cheaper), then drop any userinfo.
    const authority = URL_AUTHORITY.exec(host)?.[1];
    if (authority === undefined) return undefined;
    host = authority.slice(authority.lastIndexOf('@') + 1);
  }
  if (host.startsWith('[')) {
    // IPv6 literal, optionally with a port: `[::1]:8080`.
    const end = host.indexOf(']');
    host = end > 0 ? host.slice(0, end + 1) : host;
  } else {
    const colon = host.indexOf(':');
    if (colon !== -1 && host.indexOf(':', colon + 1) === -1) host = host.slice(0, colon);
  }
  host = toAsciiHost(host.replace(/\.+$/, ''));
  return host || undefined;
}

/** Punycode a non-ASCII host (`münchen.de` → `xn--mnchen-3ya.de`); ASCII passes through. */
function toAsciiHost(host: string): string {
  if (!/[^\x00-\x7f]/.test(host)) return host;
  return domainToASCII(host) || host;
}

/**
 * Normalise an operator host pattern: an exact host, `*.suffix` (any subdomain,
 * not the apex) or `*` (every host). `undefined` when the pattern is invalid.
 */
export function normalizeHostPattern(pattern: string | undefined | null): string | undefined {
  if (typeof pattern !== 'string') return undefined;
  const raw = pattern.trim().toLowerCase();
  if (raw === '*') return '*';
  if (raw.startsWith('*.')) {
    const suffix = toAsciiHost(raw.slice(2).replace(/\.+$/, ''));
    if (!suffix || suffix.includes('*') || suffix.startsWith('.') || /[\s/:?#@]/.test(suffix)) return undefined;
    return `*.${suffix}`;
  }
  const p = raw.replace(/\.+$/, '');
  if (p.includes('*') || p.startsWith('.')) return undefined;
  const host = normalizeHostName(p);
  return host && !/[\s/?#@]/.test(host) ? host : undefined;
}

/** See `matchHostPattern` in `resolve.ts` (public name). */
export function hostMatches(pattern: string, host: string): boolean {
  const p = normalizeHostPattern(pattern);
  const h = normalizeHostName(host);
  if (!p || !h) return false;
  if (p === '*') return true;
  if (p.startsWith('*.')) {
    const suffix = p.slice(1); // ".softy.pro"
    return h.length > suffix.length && h.endsWith(suffix);
  }
  return p === h;
}

/**
 * Specificity used to order matching host patterns (higher wins): exact host >
 * longer `*.suffix` > shorter `*.suffix` > `*`.
 */
export function hostPatternSpecificity(pattern: string): number {
  const p = normalizeHostPattern(pattern);
  if (!p) return -1;
  if (p === '*') return 0;
  if (p.startsWith('*.')) return p.length - 1;
  return Number.MAX_SAFE_INTEGER;
}

// ── User-Agent ───────────────────────────────────────────────────────────────

/** An operator contact, safe to place inside the UA comment: no parentheses, no control chars. */
export function sanitizeContact(contact: string | undefined): string | undefined {
  if (typeof contact !== 'string') return undefined;
  const clean = sanitizeHeaderValue(contact).replace(/[()]/g, '').replace(/\s+/g, ' ').trim();
  return clean || undefined;
}

/** The default UA with `contact` appended inside its comment. */
export function defaultUserAgentWithContact(contact: string | undefined): string {
  const c = sanitizeContact(contact);
  return c ? `${EVER_JOBS_DEFAULT_USER_AGENT.slice(0, -1)}; ${c})` : EVER_JOBS_DEFAULT_USER_AGENT;
}

/** See `expandUserAgent` in `env.ts` (public name). */
export function expandUserAgentValue(value: string | undefined, contact?: string): string {
  const clean = typeof value === 'string' ? sanitizeHeaderValue(value) : '';
  if (!clean) return defaultUserAgentWithContact(contact);
  const keyword = clean.toLowerCase();
  if (hasOwn(USER_AGENT_KEYWORDS, keyword)) {
    const expanded = USER_AGENT_KEYWORDS[keyword];
    return expanded === EVER_JOBS_DEFAULT_USER_AGENT ? defaultUserAgentWithContact(contact) : expanded;
  }
  if (clean === EVER_JOBS_DEFAULT_USER_AGENT) return defaultUserAgentWithContact(contact);
  return clean;
}
