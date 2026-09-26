/**
 * URL pinning for caller-supplied and scraped URLs (Spec 1689).
 *
 * Two kinds of untrusted URL reach a plugin's HTTP client or browser:
 *
 *  - the caller's `companyUrl` (the API accepts any string there), and
 *  - links read off a fetched page or bundle (`job.url`, detail `href`s).
 *
 * Fetched unchecked, either one aims our pods at whatever it names — a
 * cluster-internal service, the cloud metadata address, another tenant. A
 * single-company plugin only ever needs its own company's hosts, so the safe
 * shape is *pin-or-ignore*: accept the URL when it is https on an allowed host
 * (or one of its subdomains), otherwise fall back to the plugin's own default.
 *
 * Parsing with the WHATWG `URL` parser — the same one axios and Playwright use
 * — and then returning its serialisation is what makes the check hold: the
 * consumer re-parses exactly the string that was checked, so tricks such as
 * `https://acme.com@evil.com`, `https://evil.com#.acme.com`,
 * `https://evil.com\@acme.com` or `https://acme.com.evil.com` cannot
 * resolve to a different host than the one that was compared.
 *
 * 🛑 The pin covers the URL that is checked, not where it redirects. A plugin
 * whose HTTP client follows redirects must also pin every hop — pass
 * `allowedRedirectHosts` to `createHttpClient` — or an open redirect on an
 * allowed host re-opens the SSRF. Playwright navigations (pulsespace's
 * rendered path, mundane's Airtable embed) follow redirects unpinned.
 *
 * 🛑 {@link isPubliclyRoutableHostname} judges a NAME by its shape, not by
 * what it resolves to. It refuses dotless names, `*.svc`, reserved TLDs and
 * a last label no public TLD can have (a hyphen, the built-in Kubernetes
 * namespaces), but a two-label in-cluster name such as `argocd-server.argocd`
 * or `valkey.valkey` still passes — the pod's DNS search path resolves it.
 * Only a connect-time check of the resolved IP (a custom `lookup`) closes
 * that, and DNS rebinding with it. The crawl policy's egress guard (Spec 1690,
 * `http/crawl/egress-guard.ts`) is that check for direct `HttpClient`
 * connections while `blockPrivateNetworks` is on (the default); it does not
 * cover Playwright navigations, proxied requests or a disabled guard — so
 * still pin to a constant public allowlist rather than trusting the hostname
 * guard alone.
 */

/** Longest URL `pinUrlToHosts` will consider; longer input is refused. */
export const PIN_URL_MAX_LENGTH = 4096;

/** Options for {@link pinUrlToHosts}. */
export interface PinUrlOptions {
  /** Accept `http:` as well as `https:`. Default `false`. */
  allowHttp?: boolean;
  /**
   * Rewrite an `http:` URL to `https:` instead of refusing it. Ignored when
   * `allowHttp` is set. Default `false`.
   */
  upgradeHttp?: boolean;
  /**
   * Accept subdomains of an allowed host (dot-boundary: `jobs.acme.com` for
   * `acme.com`, never `evilacme.com`). Default `true`; set `false` to require
   * the hostname to equal an allowed host exactly.
   */
  allowSubdomains?: boolean;
  /** Accept an explicit non-default port. Default `false`. */
  allowPort?: boolean;
}

/** A URL scheme followed by `//` (`https://`, `HTTP://`, `file://`, …). */
const SCHEME_WITH_AUTHORITY_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * Last labels no public TLD has: Kubernetes' built-in namespaces, which the
 * pod DNS search path turns into `<svc>.<namespace>` service names
 * (`kubernetes.default`).
 */
const CLUSTER_NAMESPACE_LABELS = new Set(['default', 'kube-system', 'kube-public', 'kube-node-lease']);

/**
 * A redacted, loggable form of a URL: its host only (`acme.com`), or
 * `<unparseable>`. Userinfo, path, query and fragment never reach a log line —
 * a refused `companyUrl` may carry `user:pass@` or a `?token=`, and the pin
 * refuses exactly those.
 */
export function describeUrlForLog(raw: string | undefined | null): string {
  if (typeof raw !== 'string') return '<unparseable>';
  const trimmed = raw.trim().slice(0, PIN_URL_MAX_LENGTH);
  if (!trimmed) return '<unparseable>';
  let candidate = trimmed;
  if (candidate.startsWith('//')) {
    candidate = `https:${candidate}`;
  } else if (!SCHEME_WITH_AUTHORITY_RE.test(candidate)) {
    candidate = `https://${candidate}`;
  }
  try {
    const host = new URL(candidate).host;
    return host ? host.slice(0, 200) : '<unparseable>';
  } catch {
    return '<unparseable>';
  }
}

/** Characters that never belong in a bare hostname. */
const NON_HOST_CHARS_RE = /[\s/\\@#?]/;

/**
 * Suffixes that only resolve inside a private network (RFC 6761/6762/8375
 * special-use names, Kubernetes service names and common intranet TLDs).
 */
const PRIVATE_NAME_SUFFIX_RE =
  /\.(?:local|internal|localdomain|intranet|home\.arpa|svc|lan|home|corp|test|invalid|example|onion)$/;

/**
 * Return `raw` as a normalised absolute URL when it is an https URL (http
 * only with `opts.allowHttp`) on one of `allowedHosts` or a subdomain of one,
 * and `null` otherwise.
 *
 * - A schemeless value (`www.acme.com/careers`) is read as `https://…`.
 * - Credentials (`user:pass@`) are refused outright: they are never needed to
 *   read a public careers page and are the classic host-smuggling vector.
 * - An explicit non-default port is refused unless `opts.allowPort`.
 * - Hostnames compare case-insensitively and ignore one trailing root dot.
 * - The host must also pass {@link isPubliclyRoutableHostname}, so an
 *   allowlist entry can never widen the guard to loopback or a private range.
 *
 * The returned string is `URL#href` — the exact text that was checked. Callers
 * must fetch that value, never the original input.
 */
export function pinUrlToHosts(
  raw: string | undefined | null,
  allowedHosts: readonly string[],
  opts: PinUrlOptions = {},
): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > PIN_URL_MAX_LENGTH) return null;

  let candidate = trimmed;
  if (candidate.startsWith('//')) {
    candidate = `https:${candidate}`;
  } else if (!SCHEME_WITH_AUTHORITY_RE.test(candidate)) {
    candidate = `https://${candidate}`;
  }

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }

  if (url.protocol === 'http:') {
    if (!opts.allowHttp) {
      if (!opts.upgradeHttp) return null;
      url.protocol = 'https:';
    }
  } else if (url.protocol !== 'https:') {
    return null;
  }

  if (url.username || url.password) return null;
  if (url.port && !opts.allowPort) return null;

  const host = stripRootDot(url.hostname.toLowerCase());
  if (!host || !isPubliclyRoutableHostname(host)) return null;

  const allowSubdomains = opts.allowSubdomains !== false;
  const allowed = normaliseAllowedHosts(allowedHosts);
  const onAllowedHost = allowed.some(
    (entry) => host === entry || (allowSubdomains && host.endsWith(`.${entry}`)),
  );
  return onAllowedHost ? url.href : null;
}

/**
 * `true` when `host` could plausibly be a public web host: not loopback, not a
 * private, link-local, CGNAT, multicast or documentation address (IPv4 or
 * IPv6, including IPv4 carried inside an IPv6 literal), and not a dotless or
 * special-use name that only resolves inside a private network.
 *
 * Same semantics as `source-ats-recruitee`'s `isPubliclyRoutableBoardHost`
 * (Spec 1688), hardened for use as a shared guard:
 *
 * - The host is first canonicalised through the WHATWG URL host parser, so
 *   every spelling of an address (`2130706433`, `0x7f.1`, `0177.0.0.1`,
 *   `%31%32%37.0.0.1`, `::ffff:127.0.0.1`) is judged as the address it is.
 * - A trailing root dot is ignored (`localhost.` is still loopback).
 * - IPv6 is judged by prefix after full expansion, covering IPv4-mapped,
 *   IPv4-compatible, NAT64 (`64:ff9b::/96`) and 6to4 (`2002::/16`) forms.
 * - Kubernetes `*.svc` names and RFC 6761 reserved TLDs are refused.
 *
 * Anything that is not a bare hostname (contains `/`, `@`, `#`, `?`,
 * whitespace or a port) is refused.
 */
export function isPubliclyRoutableHostname(host: string | undefined | null): boolean {
  if (typeof host !== 'string') return false;
  const trimmed = host.trim().toLowerCase();
  if (!trimmed || NON_HOST_CHARS_RE.test(trimmed)) return false;

  let h = canonicalHost(trimmed);
  if (h === null) return false;
  h = stripRootDot(h);
  if (!h) return false;

  if (h.includes(':')) {
    const hextets = expandIpv6(h);
    return hextets !== null && isPublicIpv6(hextets);
  }

  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(h)) return isPublicIpv4(h);

  // A name with no dot cannot resolve outside the cluster's search domain.
  if (!h.includes('.')) return false;
  if (h === 'localhost' || h.endsWith('.localhost')) return false;
  if (PRIVATE_NAME_SUFFIX_RE.test(h)) return false;
  // a last label no public TLD has: a hyphen outside IDN 'xn--'
  // ('pg-rw.ever-gauzy-prod'), or a built-in Kubernetes namespace
  // ('kubernetes.default') — both resolve in-cluster via the search path
  const tld = h.slice(h.lastIndexOf('.') + 1);
  if (tld.includes('-') && !tld.startsWith('xn--')) return false;
  if (CLUSTER_NAMESPACE_LABELS.has(tld)) return false;
  return true;
}

/**
 * The WHATWG serialisation of a bare host (brackets stripped from IPv6), or
 * `null` when the parser rejects it. A bare IPv6 literal is bracketed first.
 */
function canonicalHost(host: string): string | null {
  const bracketed = !host.startsWith('[') && host.includes(':') ? `[${host}]` : host;
  try {
    return new URL(`http://${bracketed}/`).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return null;
  }
}

function stripRootDot(host: string): string {
  return host.endsWith('.') ? host.slice(0, -1) : host;
}

/** Lower-cased, punycoded, root-dot-free allowlist entries; junk dropped. */
function normaliseAllowedHosts(allowedHosts: readonly string[]): string[] {
  const out: string[] = [];
  for (const entry of allowedHosts ?? []) {
    if (typeof entry !== 'string') continue;
    let value = entry.trim().toLowerCase();
    if (SCHEME_WITH_AUTHORITY_RE.test(value)) {
      try {
        value = new URL(value).hostname;
      } catch {
        continue;
      }
    }
    value = value.replace(/^\*?\./, '');
    const canonical = value && !NON_HOST_CHARS_RE.test(value) ? canonicalHost(value) : null;
    const host = canonical ? stripRootDot(canonical) : '';
    if (host) out.push(host);
  }
  return out;
}

/**
 * Eight 16-bit groups of a canonical IPv6 literal, or `null` when it does not
 * parse. The WHATWG serialiser never emits an embedded dotted quad, but a
 * trailing one is accepted anyway so the helper stands on its own.
 */
function expandIpv6(h: string): number[] | null {
  let text = h;
  const dotted = text.match(/^(.*:)((?:\d{1,3}\.){3}\d{1,3})$/);
  if (dotted) {
    const quad = dotted[2].split('.').map(Number);
    if (quad.some((n) => n > 255)) return null;
    text = `${dotted[1]}${((quad[0] << 8) | quad[1]).toString(16)}:${((quad[2] << 8) | quad[3]).toString(16)}`;
  }

  const halves = text.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string): number[] | null => {
    if (!part) return [];
    const groups = part.split(':');
    const nums: number[] = [];
    for (const g of groups) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      nums.push(parseInt(g, 16));
    }
    return nums;
  };
  const head = parse(halves[0]);
  const tail = halves.length === 2 ? parse(halves[1]) : [];
  if (!head || !tail) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const fill = 8 - head.length - tail.length;
  if (fill < 1) return null;
  return [...head, ...new Array<number>(fill).fill(0), ...tail];
}

/** `true` when an expanded IPv6 address is outside every non-public range. */
function isPublicIpv6(g: number[]): boolean {
  const zeroUpTo = (n: number) => g.slice(0, n).every((x) => x === 0);
  const embedded = (hi: number, lo: number) =>
    `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;

  if (g.every((x) => x === 0)) return false;                          // ::
  if (zeroUpTo(7) && g[7] === 1) return false;                        // ::1
  if ((g[0] & 0xfe00) === 0xfc00) return false;                       // fc00::/7 unique-local
  if ((g[0] & 0xffc0) === 0xfe80) return false;                       // fe80::/10 link-local
  if ((g[0] & 0xffc0) === 0xfec0) return false;                       // fec0::/10 site-local
  if ((g[0] & 0xff00) === 0xff00) return false;                       // ff00::/8 multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return false;               // 2001:db8::/32 documentation

  // An IPv4 address embedded in an IPv6 literal is still that IPv4 address.
  if (zeroUpTo(5) && g[5] === 0xffff) return isPublicIpv4(embedded(g[6], g[7]));  // ::ffff:a.b.c.d
  if (zeroUpTo(6)) return isPublicIpv4(embedded(g[6], g[7]));                      // ::a.b.c.d
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) {
    return isPublicIpv4(embedded(g[6], g[7]));                                     // NAT64
  }
  if (g[0] === 0x2002) return isPublicIpv4(embedded(g[1], g[2]));                 // 6to4
  return true;
}

/** `true` when a dotted-quad IPv4 address is outside every non-public range. */
function isPublicIpv4(addr: string): boolean {
  const m = addr.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b, c, d] = m.slice(1).map(Number);
  if ([a, b, c, d].some((n) => Number.isNaN(n) || n > 255)) return false;
  if (a === 0 || a === 10 || a === 127) return false;        // this-host, private, loopback
  if (a === 169 && b === 254) return false;                   // link-local (cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return false;          // private
  if (a === 192 && b === 168) return false;                   // private
  if (a === 100 && b >= 64 && b <= 127) return false;         // CGNAT
  if (a === 198 && (b === 18 || b === 19)) return false;      // benchmarking
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;  // IETF assignments, TEST-NET-1
  if (a === 198 && b === 51 && c === 100) return false;       // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return false;        // TEST-NET-3
  if (a >= 224) return false;                                  // multicast + reserved
  return true;
}
