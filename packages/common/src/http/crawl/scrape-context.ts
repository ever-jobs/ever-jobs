import { Logger } from '@nestjs/common';

import { getRequestContext, runWithRequestContext } from '../../context/request-context';
import { readCrawlPolicyEnv } from './env';
import { normalizeHostName } from './policy-schema';
import { createScrapeProxyPin } from './proxy-selector';
import { explainCrawlPolicy, resetCrawlPolicyLayerCache } from './resolve';
import {
  CallerOverridesResolution,
  CrawlPolicyEnvConfig,
  CrawlPolicyOverride,
  RateLimitScope,
  ResolvedCrawlPolicy,
  ScrapeContext,
} from './types';

/**
 * The policy of one request plus what the resolver decided about the caller
 * (Spec 1714): the effective caller-override mode and the rate-limit scope before
 * the caller layer (the `per-host` proxy pin keys on it).
 */
export interface EffectiveCrawlResolution {
  policy: ResolvedCrawlPolicy;
  callerOverrides: CallerOverridesResolution;
  baseRateLimitScope: RateLimitScope;
  /**
   * Builtin host patterns applied to the request host (`BUILTIN_HOST_POLICIES`
   * keys, least specific first; empty when none applies). Spec 1715 audit C3: the
   * `per-host` proxy pin keys on the base scope only under a lock or a builtin host policy.
   */
  builtinHostPatterns: string[];
}

const logger = new Logger('CrawlPolicy');

/**
 * Run `fn` with a per-scrape context. Nested inside the request context, so the
 * request id stays visible. Spec 1690 — lane B1.
 *
 * Nesting a scrape context inside another merges them: fields `ctx` leaves out
 * are inherited from the outer one, fields it sets (even to `undefined`) replace
 * them. When both carry an `AbortSignal`, the inner scope sees one that aborts
 * when EITHER does, so an outer deadline still cancels inner work. Contexts are
 * isolated per async chain: concurrent scrapes never see each other's context.
 *
 * A new scrape (no parent context, and `ctx` brings no `proxyPin`) gets a fresh
 * `per-scrape` proxy pin (Spec 1690 §4.4), shared by every `HttpClient` the
 * scrape uses; a nested context inherits its parent's pin.
 */
export function runWithScrapeContext<T>(ctx: ScrapeContext, fn: () => T): T {
  const parent = getRequestContext()?.scrape;
  const scrape: ScrapeContext = { ...parent, ...ctx };
  if (parent?.signal && ctx.signal && parent.signal !== ctx.signal) {
    scrape.signal = anySignal([parent.signal, ctx.signal]);
  }
  if (!scrape.proxyPin) scrape.proxyPin = createScrapeProxyPin();
  return runWithRequestContext({ scrape }, fn);
}

/** The scrape context in scope, if any (undefined for CLI/test direct calls). */
export function getScrapeContext(): ScrapeContext | undefined {
  return getRequestContext()?.scrape;
}

/**
 * Resolve the policy for `host` using the scrape context in scope.
 *
 * `host` may be a hostname or a full URL. `explicit` = the options the plugin
 * passed to `createHttpClient` (the plugin layer). Results are memoised per
 * (env parse, plugin manifest, caller override, site, host, explicit value);
 * each call returns a fresh copy, so callers may mutate what they get.
 */
export function getEffectiveCrawlPolicy(host?: string, explicit?: CrawlPolicyOverride): ResolvedCrawlPolicy {
  return getEffectiveCrawlResolution(host, explicit).policy;
}

/**
 * `getEffectiveCrawlPolicy` plus the effective caller-override mode of the
 * request and its pre-caller rate-limit scope (Spec 1714), from the same memo.
 * Each call returns fresh copies.
 */
export function getEffectiveCrawlResolution(host?: string, explicit?: CrawlPolicyOverride): EffectiveCrawlResolution {
  return resolveCrawlInContext(getScrapeContext(), host, explicit);
}

/**
 * The effective caller-override mode of a request to `host` from the scrape in
 * scope, and the layer that decided it (Spec 1714 FR-2) — `getEffectiveCrawlResolution(host).callerOverrides`.
 * A plugin reads it to tell a site owner's lock (`isSiteOwnerCallerLock`) from the
 * operator's own setting (Spec 1715 audit A1). Without a host, the site-level mode.
 */
export function getEffectiveCallerOverrides(host?: string, explicit?: CrawlPolicyOverride): CallerOverridesResolution {
  return getEffectiveCrawlResolution(host, explicit).callerOverrides;
}

/**
 * `getEffectiveCrawlResolution` for an EXPLICIT scrape context instead of the one
 * in scope (same memo, same fresh copies). `HttpClient` uses it where the async
 * context may not be the request's own — e.g. a `beforeRedirect` hook, which runs
 * in a socket callback (Spec 1715 audit A0).
 */
export function resolveCrawlInContext(
  ctx: ScrapeContext | undefined,
  host?: string,
  explicit?: CrawlPolicyOverride,
): EffectiveCrawlResolution {
  const env = readCrawlPolicyEnv();
  const leaf = memoLeaf(env, ctx?.plugin, ctx?.caller);
  // A full URL and its bare host resolve alike; key on the host so per-path URLs share one entry.
  const hostKey = normalizeHostName(host);
  const key = memoKey(ctx?.site, hostKey, explicit);

  let resolved = key === undefined ? undefined : leaf.get(key);
  if (resolved === undefined) {
    const explanation = explainCrawlPolicy(
      { site: ctx?.site, host: hostKey, plugin: ctx?.plugin, explicit, caller: ctx?.caller },
      env,
    );
    for (const note of explanation.notes) logNoteOnce(note);
    resolved = {
      policy: explanation.policy,
      callerOverrides: {
        mode: explanation.callerOverrides,
        source: explanation.callerOverridesSource,
        global: explanation.globalCallerOverrides,
      },
      baseRateLimitScope: explanation.baseRateLimitScope,
      builtinHostPatterns: explanation.builtinHostPatterns,
    };
    if (key !== undefined) {
      // LRU: evict the least recently used entry, not the whole leaf — a default
      // search spans ~1,850 sites × their hosts under ONE (plugin-less, caller-less) leaf.
      if (leaf.size >= MEMO_LEAF_MAX) {
        const oldest = leaf.keys().next().value;
        if (oldest !== undefined) leaf.delete(oldest);
      }
      leaf.set(key, resolved);
    }
  } else if (key !== undefined) {
    leaf.delete(key);
    leaf.set(key, resolved);
  }
  return {
    policy: copyResolved(resolved.policy),
    callerOverrides: { ...resolved.callerOverrides },
    baseRateLimitScope: resolved.baseRateLimitScope,
    builtinHostPatterns: [...resolved.builtinHostPatterns],
  };
}

/**
 * The proxy list for a request (Spec 1690 §4.4): `explicit` (what the plugin
 * passed, normally the caller's `proxies`) if non-empty, else the scrape
 * context's caller proxies, else `EVER_JOBS_CRAWL_PROXIES`, else
 * `DEFAULT_PROXIES`, else none (`[]`; axios then still honours
 * `HTTP(S)_PROXY`/`NO_PROXY`).
 *
 * `EVER_JOBS_CRAWL_DEFAULT_PROXIES_FALLBACK` (off under `legacy`) decides whether
 * the env list falls back to `DEFAULT_PROXIES`; `JobsService` drops a caller's
 * `proxies` before they reach the context when `EVER_JOBS_CRAWL_CALLER_PROXIES`
 * is `none`; and `HttpClient` egress-checks every proxy that is not one of the
 * operator's env proxies.
 *
 * `options.ignoreCallerProxies` (Spec 1714 FR-5): skip the scrape context's
 * (caller) proxies — `HttpClient` sets it for a request to a host whose lock
 * refuses caller proxies; `explicit`, then the env list, apply as before.
 */
export function getEffectiveProxies(
  explicit?: readonly string[] | null,
  options: { ignoreCallerProxies?: boolean } = {},
): string[] {
  if (explicit && explicit.length > 0) return [...explicit];
  if (!options.ignoreCallerProxies) {
    const fromContext = getScrapeContext()?.proxies;
    if (fromContext && fromContext.length > 0) return [...fromContext];
  }
  return [...readCrawlPolicyEnv().proxies];
}

/**
 * Forget memoised policies and logged notes (tests). Not needed after
 * `resetCrawlPolicyEnvCache()`: a new env parse is a new memo key.
 */
export function resetEffectiveCrawlPolicyCache(): void {
  memo = new WeakMap();
  loggedNotes.clear();
  resetCrawlPolicyLayerCache();
}

// ── internals ────────────────────────────────────────────────────────────────

/** Stand-in WeakMap key for "no plugin manifest" / "no caller override". */
const NONE: object = Object.freeze({});
/** Entries per (env, plugin, caller) leaf, least recently used evicted first. */
export const CRAWL_POLICY_MEMO_MAX = 8192;
const MEMO_LEAF_MAX = CRAWL_POLICY_MEMO_MAX;

type MemoLeaf = Map<string, EffectiveCrawlResolution>;
let memo = new WeakMap<CrawlPolicyEnvConfig, WeakMap<object, WeakMap<object, MemoLeaf>>>();

function memoLeaf(env: CrawlPolicyEnvConfig, plugin: object | undefined, caller: object | undefined): MemoLeaf {
  let byPlugin = memo.get(env);
  if (!byPlugin) {
    byPlugin = new WeakMap();
    memo.set(env, byPlugin);
  }
  const pluginKey = plugin ?? NONE;
  let byCaller = byPlugin.get(pluginKey);
  if (!byCaller) {
    byCaller = new WeakMap();
    byPlugin.set(pluginKey, byCaller);
  }
  const callerKey = caller ?? NONE;
  let leaf = byCaller.get(callerKey);
  if (!leaf) {
    leaf = new Map();
    byCaller.set(callerKey, leaf);
  }
  return leaf;
}

/** `explicit` is keyed by value (HttpClient may rebuild it per request); undefined = not memoisable. */
function memoKey(site: string | undefined, host: string | undefined, explicit: CrawlPolicyOverride | undefined): string | undefined {
  let explicitKey = '';
  if (explicit !== undefined) {
    try {
      explicitKey = JSON.stringify(explicit);
    } catch {
      return undefined;
    }
  }
  return `${site ?? ''}\u0000${host ?? ''}\u0000${explicitKey}`;
}

/**
 * Resolution notes (an invalid manifest value, a plugin UA opt-in ignored under
 * `strict`, …) are logged once each at debug level — they repeat for every
 * request otherwise. The full list is always available from `explainCrawlPolicy`
 * and the `GET /api/sources/:site/crawl-policy` endpoint.
 */
const loggedNotes = new Set<string>();
const LOGGED_NOTES_MAX = 1000;

function logNoteOnce(note: string): void {
  if (loggedNotes.has(note)) return;
  if (loggedNotes.size >= LOGGED_NOTES_MAX) loggedNotes.clear();
  loggedNotes.add(note);
  logger.debug(note);
}

function copyResolved(policy: ResolvedCrawlPolicy): ResolvedCrawlPolicy {
  return { ...policy, retryStatuses: [...policy.retryStatuses], provenance: { ...policy.provenance } };
}

/** An AbortSignal that aborts when any of `signals` does (with that signal's reason). */
function anySignal(signals: AbortSignal[]): AbortSignal {
  const native = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  if (typeof native === 'function') return native.call(AbortSignal, signals);

  const controller = new AbortController();
  const aborted = signals.find((s) => s.aborted);
  if (aborted) {
    controller.abort(aborted.reason);
    return controller.signal;
  }
  const onAbort = (event: Event): void => {
    for (const s of signals) s.removeEventListener('abort', onAbort);
    controller.abort((event.target as AbortSignal).reason);
  };
  for (const s of signals) s.addEventListener('abort', onAbort, { once: true });
  return controller.signal;
}
