import type * as dns from 'dns';
import * as http from 'http';
import type { Agent as HttpAgent } from 'http';
import * as https from 'https';
import type { Agent as HttpsAgent } from 'https';
import { isIP, isIPv4, isIPv6 } from 'net';
import type { LookupFunction } from 'net';
import { Logger } from '@nestjs/common';

import { EgressBlockedError } from './errors';

/**
 * Egress guard (Spec 1690 §4.8): refuse to connect to loopback / private /
 * link-local / CGNAT / cluster-internal destinations, so a hostile or mistyped
 * URL (a plugin building a URL from scraped data, a caller-supplied company URL)
 * cannot reach the pod's own network. Two layers:
 *
 * 1. `assertPublicHostname` — literal check before the request (works through
 *    proxies too);
 * 2. `getGuardedAgents` — direct connections resolve through a DNS `lookup` that
 *    refuses private answers, which also defeats DNS rebinding (the check runs on
 *    every connection, on the addresses actually connected to).
 */

/** Environment variables read by the guard. */
export const EGRESS_GUARD_ENV = {
  /**
   * Comma list of hosts exempt from the guard: exact hostnames, `*.suffix`
   * patterns, or IP literals — e.g. a local mock server while the guard stays on.
   */
  ALLOW_HOSTS: 'EVER_JOBS_CRAWL_EGRESS_ALLOW_HOSTS',
} as const;

/**
 * Name suffixes that only ever resolve inside a private network. Each entry
 * blocks the bare name and every subdomain (`local` blocks `x.local`, and so
 * also `*.svc.cluster.local` / `*.cluster.local`).
 */
export const BLOCKED_HOSTNAME_SUFFIXES: readonly string[] = [
  'localhost',
  'local',
  'internal',
  'svc',
  'cluster.local',
  'svc.cluster.local',
  'localdomain',
  'home.arpa',
];

const logger = new Logger('EgressGuard');

// ── address classification ──────────────────────────────────────────────────

/** [network, prefix length] pairs over the 32-bit IPv4 space. */
const PRIVATE_V4_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00000000, 8], // 0.0.0.0/8        "this network" (0.0.0.0 reaches localhost)
  [0x0a000000, 8], // 10.0.0.0/8       RFC 1918
  [0x64400000, 10], // 100.64.0.0/10   CGNAT (RFC 6598)
  [0x7f000000, 8], // 127.0.0.0/8      loopback
  [0xa9fe0000, 16], // 169.254.0.0/16  link-local (cloud metadata lives here)
  [0xac100000, 12], // 172.16.0.0/12   RFC 1918
  [0xc0000000, 24], // 192.0.0.0/24    IETF protocol assignments
  [0xc0a80000, 16], // 192.168.0.0/16  RFC 1918
  [0xc6120000, 15], // 198.18.0.0/15   benchmarking
  [0xe0000000, 4], // 224.0.0.0/4      multicast
  [0xf0000000, 4], // 240.0.0.0/4      reserved, incl. 255.255.255.255 broadcast
];

function v4ToInt(ip: string): number {
  const parts = ip.split('.').map((p) => Number(p));
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function isPrivateV4Int(value: number): boolean {
  for (const [network, prefix] of PRIVATE_V4_RANGES) {
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    if ((value & mask) >>> 0 === network) return true;
  }
  return false;
}

/** Eight 16-bit groups of a valid IPv6 literal (embedded IPv4 tail supported). */
function parseIPv6(ip: string): number[] | null {
  let text = ip;
  // Embedded dotted IPv4 tail, e.g. ::ffff:127.0.0.1
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  if (tail.includes('.')) {
    if (!isIPv4(tail)) return null;
    const v = v4ToInt(tail);
    text = `${text.slice(0, lastColon + 1)}${(v >>> 16).toString(16)}:${(v & 0xffff).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? missing !== 0 : missing < 0) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...rest].map((g) => parseInt(g, 16));
  if (groups.length !== 8 || groups.some((g) => !Number.isInteger(g) || g < 0 || g > 0xffff)) return null;
  return groups;
}

function isPrivateV6(groups: number[]): boolean {
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups;
  const embeddedV4 = ((g6 << 16) | g7) >>> 0;
  const firstFiveZero = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;

  // ::, ::1 and the deprecated IPv4-compatible ::a.b.c.d
  if (firstFiveZero && g5 === 0) {
    if (g6 === 0 && (g7 === 0 || g7 === 1)) return true;
    return isPrivateV4Int(embeddedV4);
  }
  // ::ffff:a.b.c.d (IPv4-mapped) — and ::ffff:0:a.b.c.d (IPv4-translated, RFC 2765)
  if (firstFiveZero && g5 === 0xffff) return isPrivateV4Int(embeddedV4);
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0xffff && g5 === 0) return isPrivateV4Int(embeddedV4);
  // 64:ff9b::/96 well-known NAT64 prefix — judge the IPv4 it translates to
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return isPrivateV4Int(embeddedV4);
  // 64:ff9b:1::/48 local-use NAT64 (RFC 8215)
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 1) return true;
  // 2002::/16 6to4 — the IPv4 is in bits 16..47
  if (g0 === 0x2002) return isPrivateV4Int(((g1 << 16) | g2) >>> 0);
  // 100::/64 discard-only
  if (g0 === 0x100 && g1 === 0 && g2 === 0 && g3 === 0) return true;
  // 2001:db8::/32 documentation
  if (g0 === 0x2001 && g1 === 0xdb8) return true;
  // fc00::/7 unique local
  if ((g0 & 0xfe00) === 0xfc00) return true;
  // fe80::/10 link-local, fec0::/10 deprecated site-local
  if ((g0 & 0xffc0) === 0xfe80 || (g0 & 0xffc0) === 0xfec0) return true;
  // ff00::/8 multicast
  if ((g0 & 0xff00) === 0xff00) return true;
  return false;
}

function stripBrackets(value: string): string {
  return value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
}

/** Drop an IPv6 zone index (`fe80::1%eth0`). */
function stripZone(value: string): string {
  const pct = value.indexOf('%');
  return pct >= 0 ? value.slice(0, pct) : value;
}

/**
 * Canonical hostname the way a WHATWG URL parser (and therefore axios) sees it:
 * lower-cased, IDN → punycode, IPv4 shorthand (`2130706433`, `0x7f.1`,
 * `017700000001`) → dotted quad, userinfo / port / path dropped, trailing dots
 * stripped, IPv6 without brackets. Accepts a hostname, `host:port`, or an
 * absolute URL. Returns `''` when the input cannot be a host.
 */
export function normalizeHostLiteral(input: string): string {
  const raw = (input ?? '').trim();
  if (!raw) return '';
  const bare = stripZone(stripBrackets(raw));
  if (isIPv6(bare)) {
    try {
      return stripBrackets(new URL(`http://[${bare}]/`).hostname);
    } catch {
      return bare.toLowerCase();
    }
  }
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
  try {
    return stripBrackets(new URL(candidate).hostname).replace(/\.+$/, '').toLowerCase();
  } catch {
    return '';
  }
}

/**
 * True for loopback, RFC 1918, link-local, CGNAT, ULA, multicast, unspecified,
 * reserved / benchmarking / documentation (IPv6) ranges, and the IPv4-mapped,
 * IPv4-compatible, NAT64 and 6to4 IPv6 forms of the private IPv4 ranges.
 *
 * Non-canonical IPv4 literals that a URL parser would normalize (decimal
 * `2130706433`, hex `0x7f000001`, octal `0177.0.0.1`, short `127.1`) are
 * normalized first. Anything that is not an IP literal returns false.
 */
export function isPrivateAddress(ip: string): boolean {
  if (typeof ip !== 'string') return false;
  let value = stripZone(stripBrackets(ip.trim()));
  if (!isIP(value)) {
    const normalized = normalizeHostLiteral(value);
    if (!isIP(normalized)) return false;
    value = normalized;
  }
  if (isIPv4(value)) return isPrivateV4Int(v4ToInt(value));
  const groups = parseIPv6(value);
  // A literal net.isIPv6 accepts but we cannot parse: refuse rather than guess.
  return groups ? isPrivateV6(groups) : true;
}

// ── hostname policy ─────────────────────────────────────────────────────────

function matchesPattern(pattern: string, host: string): boolean {
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(1); // ".example.com"
    return host.endsWith(suffix) && host.length > suffix.length;
  }
  return pattern === host;
}

let cachedAllowRaw: string | undefined;
let cachedAllow: string[] = [];

function parseAllowList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
    .map((entry) => (entry.startsWith('*.') ? `*.${normalizeHostLiteral(entry.slice(2))}` : normalizeHostLiteral(entry)))
    .filter((entry) => entry && entry !== '*.');
}

/** `EVER_JOBS_CRAWL_EGRESS_ALLOW_HOSTS`, parsed (re-read whenever the variable changes). */
function envAllowList(): string[] {
  const raw = process.env[EGRESS_GUARD_ENV.ALLOW_HOSTS];
  if (raw !== cachedAllowRaw) {
    cachedAllowRaw = raw;
    cachedAllow = parseAllowList(raw);
  }
  return cachedAllow;
}

/** Options for `assertPublicHostname` / `isEgressAllowed`. */
export interface EgressGuardOptions {
  /**
   * Hosts exempt from the guard (exact host, `*.suffix`, or IP literal). Added to
   * `EVER_JOBS_CRAWL_EGRESS_ALLOW_HOSTS`.
   */
  allowHosts?: readonly string[];
}

/** True when `hostname` is exempted by the allow-list (env + options). */
export function isEgressAllowListed(hostname: string, options: EgressGuardOptions = {}): boolean {
  const host = normalizeHostLiteral(hostname);
  if (!host) return false;
  const extra = parseAllowList((options.allowHosts ?? []).join(','));
  return [...envAllowList(), ...extra].some((pattern) => matchesPattern(pattern, host));
}

/** Why `hostname` is refused, or null when it may be contacted. */
export function egressBlockReason(hostname: string, options: EgressGuardOptions = {}): string | null {
  const host = normalizeHostLiteral(hostname);
  if (!host) return 'invalid or empty hostname';
  if (isEgressAllowListed(host, options)) return null;
  if (isIP(host)) return isPrivateAddress(host) ? 'private, loopback or reserved address' : null;
  for (const suffix of BLOCKED_HOSTNAME_SUFFIXES) {
    if (host === suffix || host.endsWith(`.${suffix}`)) return `internal name (*.${suffix})`;
  }
  if (!host.includes('.')) return 'single-label (dotless) hostname';
  return null;
}

/**
 * Throws `EgressBlockedError` for `localhost` / `*.localhost`, `*.local`,
 * `*.internal`, `*.svc`, `*.svc.cluster.local`, `*.cluster.local`,
 * `*.localdomain`, `*.home.arpa`, dotless names and private IP literals
 * (including shorthand IPv4 forms and IPv4-mapped IPv6). The input is
 * normalized like a URL parser would (an absolute URL or `host:port` is
 * accepted, userinfo is ignored), so `http://example.com@127.0.0.1/` is refused.
 */
export function assertPublicHostname(hostname: string, options: EgressGuardOptions = {}): void {
  const reason = egressBlockReason(hostname, options);
  if (reason) throw new EgressBlockedError(normalizeHostLiteral(hostname) || String(hostname), reason);
}

/**
 * The egress guard for a proxy endpoint (`http://user:pw@host:port`,
 * `socks5://host:port` or a bare `host:port`): the same literal rules as
 * `assertPublicHostname`, applied to the proxy's host, so a proxy list supplied
 * by a search caller cannot open connections to the pod's own network. Throws
 * `EgressBlockedError` (the proxy's credentials are never part of the message).
 * The DNS side is covered by connecting through `createGuardedLookup`.
 */
export function assertPublicProxy(proxy: string, options: EgressGuardOptions = {}): void {
  const raw = (proxy ?? '').trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
  let host: string;
  try {
    host = new URL(withScheme).hostname;
  } catch {
    throw new EgressBlockedError('(proxy)', 'invalid proxy URL');
  }
  const reason = egressBlockReason(host, options);
  if (reason) throw new EgressBlockedError(`proxy ${normalizeHostLiteral(host) || host}`, reason);
}

/** `assertPublicHostname` for a full URL (throws `EgressBlockedError` for an unparseable one). */
export function assertPublicUrl(url: string, options: EgressGuardOptions = {}): void {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    throw new EgressBlockedError(String(url), 'invalid URL');
  }
  assertPublicHostname(hostname, options);
}

// ── DNS-level guard ─────────────────────────────────────────────────────────

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void;

/** The `(hostname, options, callback)` shape `net.connect` calls. */
export type GuardedLookupFunction = (
  hostname: string,
  options: dns.LookupOptions | number | LookupCallback,
  callback?: LookupCallback,
) => void;

/** Resolver used under the guard; `dns.lookup` by default. */
export type BaseLookup = (
  hostname: string,
  options: dns.LookupAllOptions,
  callback: (err: NodeJS.ErrnoException | null, addresses: dns.LookupAddress[]) => void,
) => void;

/**
 * The real `dns` module object. A namespace import (`import * as dns`) can
 * compile to a snapshot copy of it — @swc/jest's CommonJS interop copies a
 * CommonJS module's properties — and a copy never sees a spy (tests) or a
 * runtime patch (diagnostics, APM agents) on `dns.lookup`.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const dnsModule: typeof dns = require('dns');

const defaultBaseLookup: BaseLookup = (hostname, options, callback) =>
  // Looked up at call time so tests (and diagnostics) can spy on `dns.lookup`.
  dnsModule.lookup(hostname, options, callback);

/**
 * A `lookup` for `net.connect` / `http.Agent` that resolves ALL addresses of
 * `hostname` and fails with `EgressBlockedError` when ANY of them is private (a
 * round-robin record mixing a public and a private answer is refused, since the
 * connection could land on either). Supports `options.all` (Node ≥ 20
 * `autoSelectFamily` asks for every address) and the legacy numeric `family`.
 * Allow-listed hosts (`EVER_JOBS_CRAWL_EGRESS_ALLOW_HOSTS`, plus
 * `guardOptions.allowHosts`) resolve unfiltered. The refusal names the host but
 * not the private address it resolved to (that is logged server-side only).
 */
export function createGuardedLookup(
  baseLookup: BaseLookup = defaultBaseLookup,
  guardOptions: EgressGuardOptions = {},
): GuardedLookupFunction {
  return (hostname, options, maybeCallback) => {
    const callback = (typeof options === 'function' ? options : maybeCallback) as LookupCallback;
    const opts: dns.LookupOptions =
      typeof options === 'number' ? { family: options } : typeof options === 'object' && options ? { ...options } : {};
    const wantAll = opts.all === true;

    baseLookup(hostname, { ...opts, all: true }, (err, addresses) => {
      if (err) {
        callback(err, wantAll ? [] : '', undefined);
        return;
      }
      const list = Array.isArray(addresses) ? addresses : [];
      if (!isEgressAllowListed(hostname, guardOptions)) {
        const bad = list.find((a) => isPrivateAddress(a.address));
        if (bad) {
          // The address goes to the server log only: the error message reaches
          // API responses (scrape diagnostics), and naming the private address
          // there would turn the guard into an internal-DNS oracle.
          logger.warn(`Refused connection to ${hostname}: resolves to ${bad.address}`);
          callback(
            new EgressBlockedError(hostname, 'resolves to a private address') as unknown as NodeJS.ErrnoException,
            wantAll ? [] : '',
            undefined,
          );
          return;
        }
      }
      if (wantAll) {
        callback(null, list);
        return;
      }
      const first = list[0];
      if (!first) {
        const notFound = Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), {
          code: 'ENOTFOUND',
          hostname,
        }) as NodeJS.ErrnoException;
        callback(notFound, '', undefined);
        return;
      }
      callback(null, first.address, first.family);
    });
  };
}

/** Options for `getGuardedAgents`. */
export interface GuardedAgentOptions {
  /** `rejectUnauthorized: false` — mirrors the pre-1690 `caCert` behaviour. */
  insecureTls: boolean;
  /**
   * `false` returns shared keep-alive agents WITHOUT the DNS guard (for
   * `blockPrivateNetworks: false`), so connection reuse does not depend on the
   * guard being on. Default `true`.
   */
  guard?: boolean;
}

const agentCache = new Map<string, { httpAgent: HttpAgent; httpsAgent: HttpsAgent }>();

/**
 * Shared keep-alive agents whose DNS `lookup` refuses private addresses (defeats
 * DNS rebinding for direct connections). `insecureTls` mirrors the pre-1690
 * `caCert` behaviour (rejectUnauthorized: false). One pair per
 * (`insecureTls`, `guard`) combination, process wide. Keep-alive settings match
 * Node ≥ 20's global agent (LIFO scheduling, idle sockets closed after 5 s).
 */
export function getGuardedAgents(options: GuardedAgentOptions): { httpAgent: HttpAgent; httpsAgent: HttpsAgent } {
  const insecureTls = options?.insecureTls === true;
  const guard = options?.guard !== false;
  const key = `${insecureTls ? 'insecure' : 'verify'}|${guard ? 'guarded' : 'open'}`;
  let pair = agentCache.get(key);
  if (!pair) {
    const common = {
      keepAlive: true,
      scheduling: 'lifo' as const,
      timeout: 5000,
      ...(guard ? { lookup: createGuardedLookup() as unknown as LookupFunction } : {}),
    };
    pair = {
      httpAgent: new http.Agent(common),
      httpsAgent: new https.Agent({ ...common, ...(insecureTls ? { rejectUnauthorized: false } : {}) }),
    };
    agentCache.set(key, pair);
  }
  return pair;
}

/** Destroy and forget the shared agents (tests). */
export function resetGuardedAgents(): void {
  for (const pair of agentCache.values()) {
    pair.httpAgent.destroy();
    pair.httpsAgent.destroy();
  }
  agentCache.clear();
}
