import { Logger } from '@nestjs/common';
import * as robotsParserModule from 'robots-parser';

import { EVER_JOBS_UA_PRODUCT } from './defaults';
import { isCrawlPolicyError } from './errors';
import { RobotsDecision, RobotsTxtMode } from './types';

export type RobotsFetcher = (robotsUrl: string) => Promise<{ status: number; body: string } | null>;

/** The parsed file, as `robots-parser` exposes it. */
type Robot = ReturnType<typeof import('robots-parser').default>;
type RobotsParser = (url: string, contents: string) => Robot;

// robots-parser is CommonJS (`module.exports = function`): with esModuleInterop
// the function is `.default`, without it the namespace object IS the function.
const robotsParser: RobotsParser = ((robotsParserModule as unknown as { default?: RobotsParser }).default ??
  (robotsParserModule as unknown as RobotsParser)) as RobotsParser;

/** What to do when robots.txt is unreachable (5xx, 429, network error). */
export type RobotsUnreachablePolicy = 'allow' | 'disallow';

export interface RobotsTxtCacheOptions {
  /** LRU cap on cached origins (default 5000). */
  maxOrigins?: number;
  /** Lifetime of a fetched (2xx) or missing (4xx) robots.txt, ms (default 6 h). */
  ttlMs?: number;
  /** Lifetime of an unreachable (5xx / 429 / network error) result, ms (default 5 min). */
  errorTtlMs?: number;
  /** Bytes of robots.txt parsed; the rest is ignored (default 512 KiB, as Google does). */
  maxBytes?: number;
  /**
   * `allow` (default, Spec 1690 §4.7): an unreachable robots.txt allows
   * everything until it is retried. `disallow`: RFC 9309 §2.3.1.4 reading —
   * assume complete disallow (only matters in `respect` mode).
   */
  unreachable?: RobotsUnreachablePolicy;
  /**
   * Allow/Disallow rules kept per user-agent group; later ones are ignored
   * (default 2000). Bounds the parse and every `respect` decision.
   */
  maxRulesPerGroup?: number;
  /** Characters of an Allow/Disallow pattern kept (default 512); runs of `*` are collapsed first. */
  maxPatternChars?: number;
  /**
   * Upper bound on the matcher's work for one `respect` decision, in
   * pattern-char × path-char steps (default 5,000,000 ≈ a few tens of ms). A
   * wildcard-heavy robots.txt that would cost more for a URL is not evaluated for
   * it: the `unreachable` policy applies instead (logged once per origin).
   */
  maxMatchCost?: number;
  now?: () => number;
}

export const ROBOTS_CACHE_DEFAULTS = {
  maxOrigins: 5000,
  ttlMs: 6 * 60 * 60 * 1000,
  errorTtlMs: 5 * 60 * 1000,
  maxBytes: 512 * 1024,
  unreachable: 'allow' as RobotsUnreachablePolicy,
  maxRulesPerGroup: 2000,
  maxPatternChars: 512,
  maxMatchCost: 5_000_000,
} as const;

/** Environment variables read by `getRobotsTxtCache()` when it builds the singleton. */
export const ROBOTS_CACHE_ENV = {
  MAX_ORIGINS: 'EVER_JOBS_CRAWL_ROBOTS_MAX_ORIGINS',
  TTL_MS: 'EVER_JOBS_CRAWL_ROBOTS_TTL_MS',
  ERROR_TTL_MS: 'EVER_JOBS_CRAWL_ROBOTS_ERROR_TTL_MS',
  MAX_BYTES: 'EVER_JOBS_CRAWL_ROBOTS_MAX_BYTES',
  UNREACHABLE: 'EVER_JOBS_CRAWL_ROBOTS_UNREACHABLE',
  MAX_RULES_PER_GROUP: 'EVER_JOBS_CRAWL_ROBOTS_MAX_RULES_PER_GROUP',
  MAX_PATTERN_CHARS: 'EVER_JOBS_CRAWL_ROBOTS_MAX_PATTERN_CHARS',
  MAX_MATCH_COST: 'EVER_JOBS_CRAWL_ROBOTS_MAX_MATCH_COST',
} as const;

/** How a cached origin was classified. */
export type RobotsFetchOutcome = 'parsed' | 'missing' | 'unreachable';

/** Matcher work of one user-agent group (see `sanitizeRobotsTxt`). */
export interface RobotsGroupCost {
  /** Pattern characters up to each pattern's first `*` (matched in one pass). */
  literalChars: number;
  /** Pattern characters after each pattern's first `*` (each costs up to one pass over the path). */
  wildcardChars: number;
}

interface RobotsEntry {
  robot: Robot | null;
  outcome: RobotsFetchOutcome;
  status: number | null;
  expiresAt: number;
  /** Per group (robots-parser's normalised UA token, `*` included). */
  costs?: Map<string, RobotsGroupCost>;
  /** `respect` decisions already computed, by `token\npath` (bounded). */
  decisions?: Map<string, boolean>;
  /** Over-budget warning already logged for this origin. */
  warnedCost?: boolean;
}

/** Decisions remembered per origin. */
const DECISIONS_PER_ORIGIN = 1000;

/** A robots-parser user-agent token: lower-cased, `/version` dropped, trimmed. */
function robotsGroupKey(userAgent: string): string {
  const lower = userAgent.toLowerCase();
  const slash = lower.indexOf('/');
  return (slash > -1 ? lower.slice(0, slash) : lower).trim();
}

/** Length of a pattern after robots-parser's `encodeURI` normalisation. */
function encodedLength(pattern: string): number {
  try {
    return encodeURI(pattern).replace(/%25/g, '%').length;
  } catch {
    return pattern.length;
  }
}

/**
 * Bound a robots.txt before it is parsed (hostile-input hardening): in every
 * Allow/Disallow line, runs of `*` collapse to one (same meaning) and the pattern
 * is cut to `maxPatternChars`; rules beyond `maxRulesPerGroup` in a group are
 * dropped (blank lines keep the line numbers). Returns the bounded text and each
 * group's matcher cost, following robots-parser's own grouping rules.
 */
export function sanitizeRobotsTxt(
  text: string,
  options: { maxRulesPerGroup?: number; maxPatternChars?: number } = {},
): { text: string; costs: Map<string, RobotsGroupCost> } {
  const maxRules = positiveInt(options.maxRulesPerGroup, ROBOTS_CACHE_DEFAULTS.maxRulesPerGroup);
  const maxChars = positiveInt(options.maxPatternChars, ROBOTS_CACHE_DEFAULTS.maxPatternChars);
  const costs = new Map<string, RobotsGroupCost>();
  const lines = text.split(/\r\n|\r|\n/);
  let agents: string[] = [];
  let noneUserAgentState = true;
  let rulesInGroup = 0;

  for (let i = 0; i < lines.length; i++) {
    const hash = lines[i].indexOf('#');
    const line = hash > -1 ? lines[i].slice(0, hash) : lines[i];
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    if (!key) continue;
    const value = line.slice(colon + 1).trim();

    if (key === 'user-agent') {
      if (noneUserAgentState) {
        agents = [];
        rulesInGroup = 0;
      }
      if (value) agents.push(robotsGroupKey(value));
    } else if (key === 'allow' || key === 'disallow' || key === 'crawl-delay') {
      for (const agent of agents) {
        if (!costs.has(agent)) costs.set(agent, { literalChars: 0, wildcardChars: 0 });
      }
      if (key !== 'crawl-delay' && value) {
        if (rulesInGroup >= maxRules) {
          lines[i] = '';
        } else {
          rulesInGroup++;
          let pattern = value.replace(/\*{2,}/g, '*');
          if (pattern.length > maxChars) pattern = pattern.slice(0, maxChars);
          if (pattern !== value) lines[i] = `${line.slice(0, colon)}: ${pattern}`;
          const encoded = encodedLength(pattern);
          const star = pattern.indexOf('*');
          const literal = star < 0 ? encoded : encodedLength(pattern.slice(0, star));
          for (const agent of agents) {
            const cost = costs.get(agent) as RobotsGroupCost;
            cost.literalChars += literal;
            cost.wildcardChars += encoded - literal;
          }
        }
      }
    }
    noneUserAgentState = key !== 'user-agent';
  }
  return { text: lines.join('\n'), costs };
}

/**
 * Whether `err` (or its `cause` chain) is a failure of OUR side rather than of the
 * site's robots.txt: a cancellation (the requesting scrape's deadline / signal) or a
 * crawl-policy refusal (queue timeout, cool-down, egress guard). Such a failure says
 * nothing about the file, so it is never cached for other requests.
 */
function isLocalFailure(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 6 && current && typeof current === 'object'; depth++) {
    const e = current as { code?: unknown; name?: unknown; cause?: unknown };
    if (isCrawlPolicyError(current)) return true;
    if (e.code === 'ERR_CANCELED' || e.name === 'AbortError' || e.name === 'CanceledError') return true;
    current = e.cause;
  }
  return false;
}

const ALLOW_ALL: Readonly<RobotsDecision> = Object.freeze({ allowed: true, sitemaps: [] as string[] });

const logger = new Logger('RobotsTxtCache');

/** `EverJobs` as a product token (`EverJobs/1.0`, `(compatible; EverJobs; …)`), not inside a URL or word. */
const OUR_PRODUCT = new RegExp(`(?:^|[\\s(;])${EVER_JOBS_UA_PRODUCT}(?:[/;)\\s]|$)`, 'i');

/**
 * The robots.txt product token for a User-Agent: `EverJobs` whenever the UA is
 * ours (contains the `EverJobs` token, e.g. the default or a contact-extended
 * one), otherwise the UA's first product token (`Mozilla/5.0 …` → `Mozilla`), so
 * a plugin that sends its own UA is matched the way a site would see it.
 * Matching is case-insensitive and ignores the `/version`; groups that do not
 * name the token fall back to `User-agent: *`.
 */
export function robotsProductToken(userAgent: string | undefined): string {
  const ua = (userAgent ?? '').trim();
  if (!ua || OUR_PRODUCT.test(ua)) return EVER_JOBS_UA_PRODUCT;
  const first = ua.split(/[\s(]/, 1)[0].split('/', 1)[0].trim();
  return first || '*';
}

function positiveInt(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/** Decode a fetched body, keep at most `maxBytes` bytes and drop a truncated last line. */
function limitBody(body: unknown, maxBytes: number): string {
  let text: string;
  if (typeof body === 'string') text = body;
  else if (Buffer.isBuffer(body)) text = body.toString('utf8');
  else if (body instanceof ArrayBuffer) text = Buffer.from(body).toString('utf8');
  else if (body == null) text = '';
  else text = String(body);

  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  const cut = Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8');
  const lastBreak = Math.max(cut.lastIndexOf('\n'), cut.lastIndexOf('\r'));
  return lastBreak >= 0 ? cut.slice(0, lastBreak) : '';
}

/**
 * Per-origin robots.txt cache (Spec 1690 §4.7), LRU + TTL.
 *
 * | robots.txt response          | Treated as                        | Cached for   |
 * |------------------------------|-----------------------------------|--------------|
 * | 2xx                          | parsed (first `maxBytes` bytes)   | `ttlMs`      |
 * | 3xx (unfollowed) / 4xx ≠ 429 | missing → allow everything        | `ttlMs`      |
 * | 429 / 5xx / network error    | unreachable → allow (configurable)| `errorTtlMs` |
 *
 * Concurrent checks for one origin share a single fetch. A fetch that fails for a
 * local reason (the initiator's scrape was cancelled, its limiter slot timed out,
 * its bucket is cooling down, the egress guard refused it) is not cached: the
 * initiator gets the error and joined callers fetch again. Before parsing, a
 * file is bounded (`sanitizeRobotsTxt`), and each `respect` decision is memoised
 * and held to `maxMatchCost`. `mode: 'off'` never fetches. The fetcher is responsible for pacing / UA / egress (the HTTP layer
 * sends it through the limiter with the configured UA); it may return null or
 * throw for a network failure.
 */
export class RobotsTxtCache {
  private readonly entries = new Map<string, RobotsEntry>();
  private readonly pending = new Map<string, Promise<RobotsEntry>>();
  private readonly maxOrigins: number;
  private readonly ttlMs: number;
  private readonly errorTtlMs: number;
  private readonly maxBytes: number;
  private readonly unreachable: RobotsUnreachablePolicy;
  private readonly maxRulesPerGroup: number;
  private readonly maxPatternChars: number;
  private readonly maxMatchCost: number;
  private readonly now: () => number;

  constructor(options: RobotsTxtCacheOptions = {}) {
    this.maxOrigins = positiveInt(options.maxOrigins, ROBOTS_CACHE_DEFAULTS.maxOrigins);
    this.ttlMs = positiveInt(options.ttlMs, ROBOTS_CACHE_DEFAULTS.ttlMs);
    this.errorTtlMs = positiveInt(options.errorTtlMs, ROBOTS_CACHE_DEFAULTS.errorTtlMs);
    this.maxBytes = positiveInt(options.maxBytes, ROBOTS_CACHE_DEFAULTS.maxBytes);
    this.unreachable = options.unreachable === 'disallow' ? 'disallow' : 'allow';
    this.maxRulesPerGroup = positiveInt(options.maxRulesPerGroup, ROBOTS_CACHE_DEFAULTS.maxRulesPerGroup);
    this.maxPatternChars = positiveInt(options.maxPatternChars, ROBOTS_CACHE_DEFAULTS.maxPatternChars);
    this.maxMatchCost = positiveInt(options.maxMatchCost, ROBOTS_CACHE_DEFAULTS.maxMatchCost);
    this.now = options.now ?? (() => Date.now());
  }

  /** Number of origins cached (fresh or not yet pruned). */
  get size(): number {
    return this.entries.size;
  }

  /**
   * Decide whether `url` may be fetched with `userAgent`:
   * - `off`: allowed, nothing fetched;
   * - `crawl-delay`: always allowed; `crawlDelayMs` / `sitemaps` reported;
   * - `respect`: `allowed` follows the file's Allow/Disallow rules.
   * Non-HTTP(S) or unparseable URLs are allowed without a fetch.
   */
  async check(url: string, userAgent: string, mode: RobotsTxtMode, fetcher: RobotsFetcher): Promise<RobotsDecision> {
    if (mode !== 'crawl-delay' && mode !== 'respect') return { ...ALLOW_ALL, sitemaps: [] };

    let origin: string;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { ...ALLOW_ALL, sitemaps: [] };
      origin = parsed.origin;
    } catch {
      return { ...ALLOW_ALL, sitemaps: [] };
    }

    let entry: RobotsEntry;
    try {
      entry = await this.load(origin, fetcher);
    } catch (err) {
      // A shared fetch failed for its initiator's own reason (its scrape was
      // cancelled, its slot timed out…): that says nothing about this request,
      // so fetch again with this caller's fetcher. The initiator gets its error.
      if (!(err instanceof JoinedFetchFailure)) throw err;
      entry = await this.load(origin, fetcher);
    }
    return this.decide(entry, url, userAgent, mode);
  }

  /** Forget one origin (`https://host[:port]`), e.g. after an operator fixes their file. */
  invalidate(origin: string): boolean {
    return this.entries.delete(origin);
  }

  clear(): void {
    this.entries.clear();
  }

  /** How `origin` is currently cached, if at all (diagnostics). */
  peek(origin: string): { outcome: RobotsFetchOutcome; status: number | null; expiresAt: number } | undefined {
    const entry = this.entries.get(origin);
    if (!entry || entry.expiresAt <= this.now()) return undefined;
    return { outcome: entry.outcome, status: entry.status, expiresAt: entry.expiresAt };
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private decide(entry: RobotsEntry, url: string, userAgent: string, mode: RobotsTxtMode): RobotsDecision {
    if (!entry.robot) {
      const refuse = mode === 'respect' && entry.outcome === 'unreachable' && this.unreachable === 'disallow';
      return { allowed: !refuse, sitemaps: [] };
    }
    const token = robotsProductToken(userAgent);
    const decision: RobotsDecision = { allowed: true, sitemaps: entry.robot.getSitemaps() };

    const delaySeconds = entry.robot.getCrawlDelay(token);
    if (typeof delaySeconds === 'number' && Number.isFinite(delaySeconds) && delaySeconds > 0) {
      decision.crawlDelayMs = Math.round(delaySeconds * 1000);
    }
    if (mode === 'respect') decision.allowed = this.isAllowed(entry, url, token);
    return decision;
  }

  /**
   * robots-parser's Allow/Disallow verdict for `url`, memoised per origin, within
   * the `maxMatchCost` budget (over it: the `unreachable` policy).
   */
  private isAllowed(entry: RobotsEntry, url: string, token: string): boolean {
    const robot = entry.robot as Robot;
    let path: string;
    try {
      const parsed = new URL(url);
      path = parsed.pathname + parsed.search;
    } catch {
      return true;
    }
    const memoKey = `${token}\n${path}`;
    const memo = entry.decisions?.get(memoKey);
    if (memo !== undefined) return memo;

    let allowed: boolean;
    const group = entry.costs?.get(robotsGroupKey(token)) ?? entry.costs?.get('*');
    const cost = group ? group.literalChars + group.wildcardChars * (path.length + 1) : 0;
    if (cost > this.maxMatchCost) {
      allowed = this.unreachable !== 'disallow';
      if (!entry.warnedCost) {
        entry.warnedCost = true;
        logger.warn(
          `robots.txt of ${new URL(url).origin} is too costly to evaluate for some URLs ` +
            `(~${cost} matcher steps > ${this.maxMatchCost}); treating them as unreachable (${this.unreachable})`,
        );
      }
    } else {
      // `undefined` = the URL is not on this file's origin (cannot happen here) → allow.
      allowed = robot.isAllowed(url, token) !== false;
    }

    const decisions = entry.decisions ?? (entry.decisions = new Map());
    if (decisions.size >= DECISIONS_PER_ORIGIN) decisions.clear();
    decisions.set(memoKey, allowed);
    return allowed;
  }

  /**
   * The cached entry for `origin`, or one shared fetch of it. A fetch that fails
   * for a local reason (`isLocalFailure`) is not cached: its initiator gets the
   * error, and callers that joined it get a `JoinedFetchFailure` (they refetch).
   */
  private load(origin: string, fetcher: RobotsFetcher): Promise<RobotsEntry> {
    const cached = this.entries.get(origin);
    if (cached) {
      if (cached.expiresAt > this.now()) {
        this.entries.delete(origin);
        this.entries.set(origin, cached);
        return Promise.resolve(cached);
      }
      this.entries.delete(origin);
    }

    const inflight = this.pending.get(origin);
    if (inflight) {
      return inflight.catch((err) => {
        throw isLocalFailure(err) ? new JoinedFetchFailure(err) : err;
      });
    }

    const promise = this.fetchEntry(origin, fetcher)
      .then((entry) => {
        this.store(origin, entry);
        return entry;
      })
      .finally(() => this.pending.delete(origin));
    this.pending.set(origin, promise);
    return promise;
  }

  private store(origin: string, entry: RobotsEntry): void {
    this.entries.delete(origin);
    this.entries.set(origin, entry);
    while (this.entries.size > this.maxOrigins) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  private async fetchEntry(origin: string, fetcher: RobotsFetcher): Promise<RobotsEntry> {
    const robotsUrl = `${origin}/robots.txt`;
    let response: { status: number; body: string } | null;
    try {
      response = await fetcher(robotsUrl);
    } catch (err) {
      // Our own cancellation / pacing refusal is not a property of the site: do
      // not cache it as "unreachable" for everyone (rethrown, see `load`).
      if (isLocalFailure(err)) throw err;
      logger.debug(`robots.txt unreachable for ${origin}: ${(err as Error)?.message ?? String(err)}`);
      response = null;
    }

    const status = typeof response?.status === 'number' && Number.isFinite(response.status) ? response.status : null;
    if (!response || status === null || status === 429 || status >= 500 || status < 100) {
      return { robot: null, outcome: 'unreachable', status, expiresAt: this.now() + this.errorTtlMs };
    }
    if (status >= 200 && status < 300) {
      const { text, costs } = sanitizeRobotsTxt(limitBody(response.body, this.maxBytes), {
        maxRulesPerGroup: this.maxRulesPerGroup,
        maxPatternChars: this.maxPatternChars,
      });
      const robot = robotsParser(robotsUrl, text);
      return { robot, outcome: 'parsed', status, expiresAt: this.now() + this.ttlMs, costs };
    }
    return { robot: null, outcome: 'missing', status, expiresAt: this.now() + this.ttlMs };
  }
}

/** A caller joined a shared robots.txt fetch that failed for its initiator's own (local) reason. */
class JoinedFetchFailure extends Error {
  constructor(readonly original: unknown) {
    super('shared robots.txt fetch failed for another request');
    this.name = 'JoinedFetchFailure';
  }
}

function envInt(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value <= 0) {
    logger.warn(`Ignoring ${name}=${JSON.stringify(raw)}: expected a positive integer`);
    return undefined;
  }
  return value;
}

/** Read `ROBOTS_CACHE_ENV` into cache options; invalid values are ignored with a warning. */
export function robotsTxtCacheOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): RobotsTxtCacheOptions {
  const options: RobotsTxtCacheOptions = {
    maxOrigins: envInt(env, ROBOTS_CACHE_ENV.MAX_ORIGINS),
    ttlMs: envInt(env, ROBOTS_CACHE_ENV.TTL_MS),
    errorTtlMs: envInt(env, ROBOTS_CACHE_ENV.ERROR_TTL_MS),
    maxBytes: envInt(env, ROBOTS_CACHE_ENV.MAX_BYTES),
    maxRulesPerGroup: envInt(env, ROBOTS_CACHE_ENV.MAX_RULES_PER_GROUP),
    maxPatternChars: envInt(env, ROBOTS_CACHE_ENV.MAX_PATTERN_CHARS),
    maxMatchCost: envInt(env, ROBOTS_CACHE_ENV.MAX_MATCH_COST),
  };
  const unreachable = env[ROBOTS_CACHE_ENV.UNREACHABLE]?.trim().toLowerCase();
  if (unreachable === 'allow' || unreachable === 'disallow') options.unreachable = unreachable;
  else if (unreachable) {
    logger.warn(`Ignoring ${ROBOTS_CACHE_ENV.UNREACHABLE}=${JSON.stringify(unreachable)}: expected allow or disallow`);
  }
  return options;
}

let singleton: RobotsTxtCache | undefined;

/** The process-wide robots.txt cache (created on first use from `ROBOTS_CACHE_ENV`). */
export function getRobotsTxtCache(): RobotsTxtCache {
  if (!singleton) singleton = new RobotsTxtCache(robotsTxtCacheOptionsFromEnv());
  return singleton;
}

/** Replace the process-wide cache (tests). Without an argument the next `getRobotsTxtCache()` builds a fresh one. */
export function resetRobotsTxtCache(cache?: RobotsTxtCache): void {
  singleton = cache;
}
